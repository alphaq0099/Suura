import type { Logger } from '@core/logging/logger'
import type { YouTubeSearchResult } from '@shared/types'
import { isYouTubeVideoId, normalizeArtistName, youtubeChannelUrl } from '@shared/youtube'
import { RequestScheduler } from './sidecar/request-scheduler'
import type { YtChannelInfo, YtSearchProvider } from './sidecar/yt-dlp'

/**
 * Discovery without the yt-dlp sidecar.
 *
 * YouTube's own web client talks to InnerTube: plain JSON over HTTPS, no
 * player, no formats and no signed URL. Search and channel pages live there,
 * while playback still needs yt-dlp. Keeping the two apart means a search
 * cannot spend the anonymous request budget that a resolve needs, and search
 * keeps working while playback is inside a bot-check cooldown.
 *
 * InnerTube is not a published API. The parser is deliberately defensive and
 * only reads the renderers it knows; the smoke tests pin the shape it expects.
 */

const ORIGIN = 'https://www.youtube.com'
const SEARCH_PATH = '/youtubei/v1/search'
const BROWSE_PATH = '/youtubei/v1/browse'
const RESOLVE_PATH = '/youtubei/v1/navigation/resolve_url'

/** The web client version used for the request. Update when YouTube rejects it. */
const WEB_CLIENT_VERSION = '2.20260918.00.00'
const WEB_CLIENT_NAME = '1'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** Channel pages ask for the Videos tab, not the channel's default landing tab. */
const CHANNEL_VIDEOS_PARAMS = 'EgZ2aWRlb3PyBgQKAjoA'

const REQUEST_TIMEOUT_MS = 15_000
const REQUEST_GAP_MS = 250
const REQUEST_JITTER_MS = 150

/** Enough pages to fill the deepest offset the UI allows, without a runaway. */
const MAX_PAGE_FETCHES = 12
const MAX_FEED_ITEMS = 500
const FEED_TTL_MS = 5 * 60_000
const MAX_SEARCH_FEEDS = 60
const MAX_CHANNEL_FEEDS = 30
const MAX_CHANNEL_IDENTITIES = 30

type JsonObject = Record<string, unknown>

export interface InnerTubePage<T> {
  items: T[]
  continuation: string | null
}

export class InnerTubeError extends Error {
  constructor(
    message: string,
    readonly detail: string
  ) {
    super(message)
    this.name = 'InnerTubeError'
  }
}

interface Feed<T> {
  items: T[]
  continuation: string | null
  exhausted: boolean
  started: boolean
  updatedAt: number
  pending: Promise<void> | null
}

interface ChannelFeed extends Feed<YouTubeSearchResult> {
  channelId: string
  name: string
  url: string
}

interface ChannelIdentity {
  id: string
  url: string
  at: number
}

/**
 * Search and channel listings over InnerTube.
 *
 * Implements the same narrow interface the sidecar did, so the Online service
 * and the whole discovery UI do not know which provider answers.
 */
export class InnerTubeMetadataClient implements YtSearchProvider {
  private readonly searchFeeds = new Map<string, Feed<YouTubeSearchResult>>()
  private readonly channelFeeds = new Map<string, ChannelFeed>()
  private readonly channelIdentities = new Map<string, ChannelIdentity>()
  private readonly scheduler: RequestScheduler
  private readonly now: () => number
  private readonly fetcher: typeof fetch
  private readonly clientVersion: string
  private visitorData: string | null = null

  constructor(
    private readonly deps: {
      log: Logger
      /** Injectable for tests; the real default is the global fetch. */
      fetchImpl?: typeof fetch
      now?: () => number
      clientVersion?: string
    }
  ) {
    this.now = deps.now ?? Date.now
    this.fetcher = deps.fetchImpl ?? fetch
    this.clientVersion = deps.clientVersion ?? WEB_CLIENT_VERSION
    this.scheduler = new RequestScheduler({
      maxConcurrent: 1,
      minGapMs: REQUEST_GAP_MS,
      jitterMs: REQUEST_JITTER_MS
    })
  }

  async search(query: string, limit: number, offset = 0, signal?: AbortSignal): Promise<YouTubeSearchResult[]> {
    const text = query.trim()
    if (text.length === 0) throw new InnerTubeError('Type something to search for.', 'empty-query')

    const count = pageSize(limit)
    const start = pageOffset(offset)
    const feed = await this.ensureSearchFeed(text, start + count, signal)
    return feed.items.slice(start, start + count)
  }

  async channel(target: string, limit: number, offset = 0, signal?: AbortSignal): Promise<YtChannelInfo> {
    const normalized = youtubeChannelUrl(target)
    if (!normalized) throw new InnerTubeError('That does not look like a channel link or id.', 'bad-channel')

    const identity = await this.resolveChannelIdentity(normalized, signal)
    const count = pageSize(limit)
    const start = pageOffset(offset)
    const feed = await this.ensureChannelFeed(identity, start + count, signal)

    return {
      channelId: feed.channelId,
      name: feed.name,
      url: feed.url,
      entries: feed.items.slice(start, start + count)
    }
  }

  /**
   * One search feed per query, shared by every page the user visits.
   *
   * The first page is one request. Later pages reuse the results already in
   * the feed and only fetch a continuation when the page is not long enough.
   */
  private async ensureSearchFeed(
    query: string,
    needed: number,
    signal?: AbortSignal
  ): Promise<Feed<YouTubeSearchResult>> {
    const key = query.toLowerCase()
    const existing = this.searchFeeds.get(key)
    const feed =
      existing && this.now() - existing.updatedAt <= FEED_TTL_MS
        ? existing
        : this.newFeed<YouTubeSearchResult>()

    if (feed !== existing) {
      this.searchFeeds.set(key, feed)
      this.pruneFeeds(this.searchFeeds, MAX_SEARCH_FEEDS)
    }

    for (let page = 0; page < MAX_PAGE_FETCHES && feed.items.length < needed && !feed.exhausted; page += 1) {
      checkAborted(signal)
      if (feed.pending) {
        await feed.pending
        continue
      }

      const work = this.fetchSearchPage(feed, query, signal).finally(() => {
        feed.pending = null
      })
      feed.pending = work
      await work
    }

    return feed
  }

  private async fetchSearchPage(
    feed: Feed<YouTubeSearchResult>,
    query: string,
    signal?: AbortSignal
  ): Promise<void> {
    const previous = feed.continuation
    const body: JsonObject =
      feed.started && previous
        ? { context: this.context(), continuation: previous }
        : { context: this.context(), query }

    const json = await this.post(SEARCH_PATH, body, signal, 'Searching YouTube was cancelled.')
    const page = parseSearchPage(json)
    appendUnique(feed.items, page.items)
    feed.started = true
    feed.continuation = page.continuation
    feed.exhausted = !page.continuation || (page.items.length === 0 && page.continuation === previous)
    feed.updatedAt = this.now()
  }

  private async ensureChannelFeed(
    identity: ChannelIdentity,
    needed: number,
    signal?: AbortSignal
  ): Promise<ChannelFeed> {
    const existing = this.channelFeeds.get(identity.id)
    const feed: ChannelFeed =
      existing && this.now() - existing.updatedAt <= FEED_TTL_MS
        ? existing
        : {
            ...this.newFeed<YouTubeSearchResult>(),
            channelId: identity.id,
            name: 'Channel',
            url: identity.url
          }

    if (feed !== existing) {
      this.channelFeeds.set(identity.id, feed)
      this.pruneFeeds(this.channelFeeds, MAX_CHANNEL_FEEDS)
    }

    for (let page = 0; page < MAX_PAGE_FETCHES && feed.items.length < needed && !feed.exhausted; page += 1) {
      checkAborted(signal)
      if (feed.pending) {
        await feed.pending
        continue
      }

      const work = this.fetchChannelPage(feed, signal).finally(() => {
        feed.pending = null
      })
      feed.pending = work
      await work
    }

    return feed
  }

  private async fetchChannelPage(feed: ChannelFeed, signal?: AbortSignal): Promise<void> {
    const previous = feed.continuation
    const body: JsonObject =
      feed.started && previous
        ? { context: this.context(), continuation: previous }
        : {
            context: this.context(),
            browseId: feed.channelId,
            params: CHANNEL_VIDEOS_PARAMS
          }

    const json = await this.post(BROWSE_PATH, body, signal, 'Loading the channel was cancelled.')
    const info = parseChannelInfo(json, feed.url)
    if (info.channelId) feed.channelId = info.channelId
    if (info.name !== 'Channel') feed.name = info.name
    if (info.url) feed.url = info.url

    const page = parseChannelPage(json, {
      channelId: feed.channelId,
      name: feed.name,
      url: feed.url
    })
    appendUnique(feed.items, page.items)
    feed.started = true
    feed.continuation = page.continuation
    feed.exhausted = !page.continuation || (page.items.length === 0 && page.continuation === previous)
    feed.updatedAt = this.now()
  }

  /** Turns an @handle or /c/ URL into the stable UC… id, once per session. */
  private async resolveChannelIdentity(normalizedUrl: string, signal?: AbortSignal): Promise<ChannelIdentity> {
    const cached = this.channelIdentities.get(normalizedUrl)
    if (cached && this.now() - cached.at <= FEED_TTL_MS) return cached

    const known = normalizedUrl.match(/\/channel\/(UC[\w-]{22})(?:\/|$)/)
    if (known?.[1]) {
      const identity = { id: known[1], url: normalizedUrl, at: this.now() }
      this.channelIdentities.set(normalizedUrl, identity)
      this.pruneIdentities()
      return identity
    }

    const json = await this.post(
      RESOLVE_PATH,
      { context: this.context(), url: normalizedUrl },
      signal,
      'Finding the channel was cancelled.'
    )
    const id = parseResolvedChannelId(json)
    if (!id) throw new InnerTubeError('Could not find that channel.', 'channel-not-found')

    const identity = {
      id,
      url: `https://www.youtube.com/channel/${id}/videos`,
      at: this.now()
    }
    this.channelIdentities.set(normalizedUrl, identity)
    this.pruneIdentities()
    return identity
  }

  private newFeed<T>(): Feed<T> {
    return {
      items: [],
      continuation: null,
      exhausted: false,
      started: false,
      updatedAt: this.now(),
      pending: null
    }
  }

  private pruneFeeds<T>(feeds: Map<string, T & { updatedAt: number }>, maximum: number): void {
    if (feeds.size <= maximum) return
    const oldest = [...feeds.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    for (const [key] of oldest.slice(0, feeds.size - maximum)) feeds.delete(key)
  }

  private pruneIdentities(): void {
    if (this.channelIdentities.size <= MAX_CHANNEL_IDENTITIES) return
    const oldest = [...this.channelIdentities.entries()].sort((left, right) => left[1].at - right[1].at)
    for (const [key] of oldest.slice(0, this.channelIdentities.size - MAX_CHANNEL_IDENTITIES)) {
      this.channelIdentities.delete(key)
    }
  }

  private context(): JsonObject {
    const client: JsonObject = {
      clientName: 'WEB',
      clientVersion: this.clientVersion,
      hl: 'en',
      gl: 'US'
    }
    // The first response carries a visitor id. Reusing it makes a burst of
    // search pages look like one browser session rather than unrelated hits.
    if (this.visitorData) client.visitorData = this.visitorData
    return { client }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      'accept-language': 'en-US,en;q=0.9',
      'x-youtube-client-name': WEB_CLIENT_NAME,
      'x-youtube-client-version': this.clientVersion
    }
    if (this.visitorData) headers['x-goog-visitor-id'] = this.visitorData
    return headers
  }

  private post(
    path: string,
    body: JsonObject,
    signal: AbortSignal | undefined,
    abortMessage: string
  ): Promise<JsonObject> {
    const work = async (): Promise<JsonObject> => {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout

      let response: Response
      try {
        response = await this.fetcher(`${ORIGIN}${path}?prettyPrint=false`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: requestSignal
        })
      } catch (error) {
        if (signal?.aborted) throw new Error(abortMessage)
        if (isTimeout(error)) {
          throw new InnerTubeError('YouTube took too long to answer. Try again.', 'timeout')
        }
        this.deps.log.warn('InnerTube request failed', { path, error: messageOf(error) })
        throw new InnerTubeError('Could not reach YouTube. Check the connection and try again.', 'network')
      }

      if (!response.ok) {
        this.deps.log.warn('InnerTube request was refused', { path, status: response.status })
        throw httpFailure(response.status)
      }

      let raw: unknown
      try {
        raw = await response.json()
      } catch {
        throw new InnerTubeError('YouTube returned something unreadable. Try again.', 'invalid-json')
      }

      const json = asObject(raw)
      if (!json) throw new InnerTubeError('YouTube returned something unreadable. Try again.', 'empty-json')

      const visitor = stringAt(json, 'responseContext', 'visitorData')
      if (visitor) this.visitorData = visitor
      return json
    }

    return this.scheduler.schedule(work, {
      signal,
      onAbort: () => new Error(abortMessage)
    })
  }
}

/**
 * One search response, in the shape the Online service consumes.
 *
 * The first response puts its items under `sectionListRenderer`; later pages
 * arrive as `appendContinuationItemsAction` on either commands or actions.
 */
export function parseSearchPage(json: unknown): InnerTubePage<YouTubeSearchResult> {
  const items: YouTubeSearchResult[] = []
  const seen = new Set<string>()
  let continuation: string | null = null

  for (const container of searchContainers(json)) {
    for (const video of searchVideos(container)) {
      const parsed = parseVideoRenderer(video)
      if (!parsed || seen.has(parsed.videoId)) continue
      seen.add(parsed.videoId)
      items.push(parsed)
    }
    continuation = continuationToken(container) ?? continuation
  }

  return { items, continuation }
}

/** One channel page, with entries that know the channel they came from. */
export function parseChannelPage(
  json: unknown,
  channel: { channelId: string | null; name: string; url: string }
): InnerTubePage<YouTubeSearchResult> {
  const items: YouTubeSearchResult[] = []
  const seen = new Set<string>()
  let continuation: string | null = null

  for (const container of channelContainers(json)) {
    for (const item of channelItems(container)) {
      const object = asObject(item)
      if (!object) continue

      const rich = asObject(getPath(object, 'richItemRenderer', 'content'))
      const lockup = asObject(getPath(rich, 'lockupViewModel')) ?? asObject(getPath(object, 'lockupViewModel'))
      const video =
        asObject(getPath(rich, 'videoRenderer')) ??
        asObject(getPath(object, 'videoRenderer')) ??
        asObject(getPath(rich, 'gridVideoRenderer')) ??
        asObject(getPath(object, 'gridVideoRenderer'))

      const parsed = lockup
        ? parseLockupRenderer(lockup, channel)
        : video
          ? parseVideoRenderer(video)
          : null
      if (!parsed || seen.has(parsed.videoId)) continue

      seen.add(parsed.videoId)
      const listedName = normalizeArtistName(channel.name)
      const name = listedName && listedName !== 'Channel' ? listedName : parsed.channelName
      items.push({
        ...parsed,
        artist: name ?? parsed.artist,
        channelId: channel.channelId ?? parsed.channelId,
        channelName: name ?? parsed.channelName
      })
    }
    continuation = continuationToken(container) ?? continuation
  }

  return { items, continuation }
}

/** The channel name and stable id carried by a browse response. */
export function parseChannelInfo(
  json: unknown,
  fallbackUrl: string
): { channelId: string | null; name: string; url: string } {
  const id = stringAt(json, 'metadata', 'channelMetadataRenderer', 'externalId')
  const channelId = isChannelId(id) ? id : null
  const name =
    stringAt(json, 'metadata', 'channelMetadataRenderer', 'title') ??
    stringAt(json, 'header', 'pageHeaderRenderer', 'pageTitle') ??
    'Channel'

  return {
    channelId,
    name,
    url: channelId ? `https://www.youtube.com/channel/${channelId}/videos` : fallbackUrl
  }
}

/** The browse id from a `navigation/resolve_url` response. */
export function parseResolvedChannelId(json: unknown): string | null {
  const direct = stringAt(json, 'endpoint', 'browseEndpoint', 'browseId')
  if (isChannelId(direct)) return direct

  const canonical =
    stringAt(json, 'endpoint', 'browseEndpoint', 'canonicalBaseUrl') ??
    stringAt(json, 'endpoint', 'commandMetadata', 'webCommandMetadata', 'url')
  return canonical?.match(/\/channel\/(UC[\w-]{22})(?:\/|$)/)?.[1] ?? null
}

/**
 * `1:02:03`, `12:34` or YouTube's accessible `1 hour, 2 minutes, 3 seconds`.
 *
 * Live and upcoming labels deliberately return null: a discovery row with no
 * duration is not a track this player can queue.
 */
export function parseDurationText(text: string | null | undefined): number | null {
  const value = text?.trim()
  if (!value) return null
  if (/^(live|upcoming|premiere|premieres|streamed|streaming)\b/i.test(value)) return null

  if (/^\d+(?::\d+){1,2}$/.test(value)) {
    const parts = value.split(':').map(Number)
    if (parts.some((part) => !Number.isFinite(part))) return null

    if (parts.length === 2) {
      const [minutes, seconds] = parts
      if (minutes === undefined || seconds === undefined || seconds >= 60) return null
      const total = minutes * 60 + seconds
      return total > 0 ? total * 1000 : null
    }

    const [hours, minutes, seconds] = parts
    if (hours === undefined || minutes === undefined || seconds === undefined) return null
    if (minutes >= 60 || seconds >= 60) return null
    const total = hours * 3600 + minutes * 60 + seconds
    return total > 0 ? total * 1000 : null
  }

  const hours = /(\d+)\s*hour/i.exec(value)
  const minutes = /(\d+)\s*minute/i.exec(value)
  const seconds = /(\d+)\s*second/i.exec(value)
  if (!hours && !minutes && !seconds) return null

  const total = Number(hours?.[1] ?? 0) * 3600 + Number(minutes?.[1] ?? 0) * 60 + Number(seconds?.[1] ?? 0)
  return total > 0 ? total * 1000 : null
}

function parseVideoRenderer(value: unknown): YouTubeSearchResult | null {
  const video = asObject(value)
  if (!video) return null

  const videoId = stringAt(video, 'videoId')
  if (!videoId || !isYouTubeVideoId(videoId)) return null

  const title = textOf(video.title)
  if (!title) return null

  const byline =
    bylineOf(video.ownerText) ?? bylineOf(video.longBylineText) ?? bylineOf(video.shortBylineText)
  const durationText =
    stringAt(video, 'lengthText', 'simpleText') ??
    stringAt(video, 'lengthText', 'accessibility', 'accessibilityData', 'label') ??
    overlayDurationText(video)
  const durationMs = parseDurationText(durationText)
  if (durationMs === null || isUnavailable(video)) return null

  const artist = normalizeArtistName(byline?.text ?? null)
  return {
    videoId,
    title,
    artist,
    durationMs,
    channelId: byline?.channelId ?? null,
    channelName: artist
  }
}

function parseLockupRenderer(
  value: unknown,
  channel: { channelId: string | null; name: string; url: string }
): YouTubeSearchResult | null {
  const lockup = asObject(value)
  if (!lockup) return null

  const contentType = stringAt(lockup, 'contentType')
  if (contentType && contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null

  const videoId = stringAt(lockup, 'contentId')
  if (!videoId || !isYouTubeVideoId(videoId)) return null

  const title =
    stringAt(lockup, 'metadata', 'lockupMetadataViewModel', 'title', 'content') ??
    textOf(getPath(lockup, 'metadata', 'lockupMetadataViewModel', 'title'))
  if (!title) return null

  const badgeTexts = asArray(getPath(lockup, 'contentImage', 'thumbnailViewModel', 'overlays'))
    .flatMap((overlay) =>
      asArray(getPath(overlay, 'thumbnailBottomOverlayViewModel', 'badges'))
        .map((badge) => stringAt(badge, 'thumbnailBadgeViewModel', 'text'))
        .filter((text): text is string => text !== null)
    )
  const durationMs = badgeTexts.map(parseDurationText).find((value): value is number => value !== null) ?? null
  if (durationMs === null) return null

  const artist = normalizeArtistName(channel.name)
  return {
    videoId,
    title,
    artist,
    durationMs,
    channelId: channel.channelId,
    channelName: artist
  }
}

function searchContainers(json: unknown): unknown[] {
  const containers: unknown[] = []
  pushArray(
    containers,
    getPath(json, 'contents', 'twoColumnSearchResultsRenderer', 'primaryContents', 'sectionListRenderer', 'contents')
  )

  for (const command of asArray(getPath(json, 'onResponseReceivedCommands'))) {
    pushArray(containers, getPath(command, 'appendContinuationItemsAction', 'continuationItems'))
  }
  pushArray(containers, getPath(json, 'continuationContents', 'sectionListContinuation', 'contents'))
  return containers
}

function searchVideos(container: unknown): unknown[] {
  const object = asObject(container)
  if (!object) return []

  const videos: unknown[] = []
  addVideo(videos, object.videoRenderer)
  addVideo(videos, object.compactVideoRenderer)

  for (const child of asArray(getPath(object, 'itemSectionRenderer', 'contents'))) {
    const childObject = asObject(child)
    if (!childObject) continue
    addVideo(videos, childObject.videoRenderer)
    addVideo(videos, childObject.compactVideoRenderer)
    collectShelfVideos(videos, childObject)
  }

  collectShelfVideos(videos, object)
  for (const item of asArray(getPath(object, 'gridRenderer', 'items'))) {
    const itemObject = asObject(item)
    if (!itemObject) continue
    addVideo(videos, itemObject.videoRenderer)
    addVideo(videos, itemObject.compactVideoRenderer)
  }
  return videos
}

function collectShelfVideos(videos: unknown[], object: JsonObject): void {
  const shelves = [
    getPath(object, 'shelfRenderer', 'content', 'horizontalListRenderer', 'items'),
    getPath(object, 'richShelfRenderer', 'contents'),
    getPath(object, 'gridRenderer', 'items')
  ]
  for (const shelf of shelves) {
    for (const item of asArray(shelf)) {
      const itemObject = asObject(item)
      if (!itemObject) continue
      addVideo(videos, itemObject.videoRenderer)
      addVideo(videos, itemObject.compactVideoRenderer)
    }
  }
}

function channelContainers(json: unknown): unknown[] {
  const containers: unknown[] = []
  const tabs = asArray(getPath(json, 'contents', 'twoColumnBrowseResultsRenderer', 'tabs'))
    .map((tab) => asObject(getPath(tab, 'tabRenderer')))
    .filter((tab): tab is JsonObject => tab !== null)
  const active =
    tabs.find((tab) => tab.selected === true) ??
    tabs.find((tab) => stringAt(tab, 'title') === 'Videos') ??
    tabs[0]

  pushArray(containers, getPath(active, 'content', 'richGridRenderer', 'contents'))
  pushArray(containers, getPath(active, 'content', 'sectionListRenderer', 'contents'))
  if (containers.length === 0) {
    pushArray(
      containers,
      getPath(json, 'contents', 'twoColumnBrowseResultsRenderer', 'primaryContents', 'sectionListRenderer', 'contents')
    )
  }

  for (const command of [
    ...asArray(getPath(json, 'onResponseReceivedCommands')),
    ...asArray(getPath(json, 'onResponseReceivedActions'))
  ]) {
    pushArray(containers, getPath(command, 'appendContinuationItemsAction', 'continuationItems'))
    pushArray(containers, getPath(command, 'reloadContinuationItemsCommand', 'continuationItems'))
  }
  pushArray(containers, getPath(json, 'continuationContents', 'gridContinuation', 'items'))
  return containers
}

function channelItems(container: unknown): unknown[] {
  const object = asObject(container)
  if (!object) return []

  if (object.richItemRenderer || object.lockupViewModel || object.videoRenderer || object.gridVideoRenderer) {
    return [container]
  }
  return asArray(getPath(object, 'itemSectionRenderer', 'contents'))
}

function continuationToken(value: unknown): string | null {
  const direct = stringAt(value, 'continuationItemRenderer', 'continuationEndpoint', 'continuationCommand', 'token')
  if (direct) return direct

  for (const child of asArray(getPath(value, 'itemSectionRenderer', 'contents'))) {
    const nested = continuationToken(child)
    if (nested) return nested
  }
  return null
}

function overlayDurationText(video: JsonObject): string | null {
  for (const overlay of asArray(video.thumbnailOverlays)) {
    const text =
      stringAt(overlay, 'thumbnailOverlayTimeStatusRenderer', 'text', 'simpleText') ??
      stringAt(overlay, 'thumbnailOverlayTimeStatusRenderer', 'text', 'accessibility', 'accessibilityData', 'label')
    if (text) return text
  }
  return null
}

function isUnavailable(video: JsonObject): boolean {
  const labels = [...asArray(video.badges), ...asArray(video.ownerBadges)]
    .map((badge) => stringAt(badge, 'metadataBadgeRenderer', 'label') ?? '')
    .join(' ')
    .toLowerCase()
  if (/\b(members only|private|premium|upcoming|live)\b/.test(labels)) return true

  for (const overlay of asArray(video.thumbnailOverlays)) {
    const style = stringAt(overlay, 'thumbnailOverlayTimeStatusRenderer', 'style')
    if (style === 'LIVE' || style === 'UPCOMING') return true
  }
  return false
}

interface Byline {
  text: string
  channelId: string | null
}

function bylineOf(value: unknown): Byline | null {
  const first = asObject(asArray(getPath(value, 'runs'))[0])
  if (!first) return null

  const text = stringAt(first, 'text')
  if (!text) return null

  const direct = stringAt(first, 'navigationEndpoint', 'browseEndpoint', 'browseId')
  const canonical =
    stringAt(first, 'navigationEndpoint', 'browseEndpoint', 'canonicalBaseUrl') ??
    stringAt(first, 'navigationEndpoint', 'commandMetadata', 'webCommandMetadata', 'url')
  const fromUrl = canonical?.match(/\/channel\/(UC[\w-]{22})(?:\/|$)/)?.[1] ?? null

  return { text, channelId: isChannelId(direct) ? direct : fromUrl }
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null

  const object = asObject(value)
  if (!object) return null

  const simple = stringAt(object, 'simpleText')
  if (simple) return simple

  const runs = asArray(object.runs)
  if (runs.length > 0) {
    const text = runs.map((run) => stringAt(run, 'text') ?? '').join('').trim()
    if (text.length > 0) return text
  }
  return stringAt(object, 'content')
}

function getPath(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value
  for (const key of keys) {
    const object = asObject(current)
    if (!object) return undefined
    current = object[key]
  }
  return current
}

function stringAt(value: unknown, ...keys: string[]): string | null {
  const candidate = getPath(value, ...keys)
  if (typeof candidate !== 'string') return null
  const trimmed = candidate.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asObject(value: unknown): JsonObject | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as JsonObject
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function addVideo(target: unknown[], value: unknown): void {
  if (asObject(value)) target.push(value)
}

function pushArray(target: unknown[], value: unknown): void {
  for (const item of asArray(value)) target.push(item)
}

function appendUnique(items: YouTubeSearchResult[], incoming: YouTubeSearchResult[]): void {
  const seen = new Set(items.map((item) => item.videoId))
  for (const item of incoming) {
    if (items.length >= MAX_FEED_ITEMS) return
    if (seen.has(item.videoId)) continue
    seen.add(item.videoId)
    items.push(item)
  }
}

function isChannelId(value: string | null): value is string {
  return value !== null && /^UC[\w-]{22}$/.test(value)
}

function pageSize(value: number): number {
  if (!Number.isFinite(value)) return 10
  return Math.max(1, Math.min(50, Math.floor(value)))
}

function pageOffset(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(490, Math.floor(value)))
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('The YouTube request was cancelled.')
}

function httpFailure(status: number): InnerTubeError {
  if (status === 429) {
    return new InnerTubeError('YouTube is rate-limiting requests right now. Try again in a few minutes.', 'http-429')
  }
  if (status === 403) {
    return new InnerTubeError('YouTube refused the request. Try again later.', 'http-403')
  }
  if (status >= 500) {
    return new InnerTubeError('YouTube had a problem answering. Try again.', 'http-5xx')
  }
  return new InnerTubeError('YouTube could not answer. Try again.', `http-${status}`)
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
