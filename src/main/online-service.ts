import type { Logger } from '@core/logging/logger'
import type { OnlinePlaylistRepository } from '@core/library/online-playlist-repository'
import type { OnlineRepository } from '@core/library/online-repository'
import type { YtPlaylistProvider, YtSearchProvider } from '@engine/sidecar/yt-dlp'
import type { YouTubeResolver } from '@engine/youtube-resolver'
import type {
  EngineSettings,
  OnlinePlaylist,
  OnlinePlaylistDetail,
  OnlineTrack,
  YouTubeChannel,
  YouTubeSearchResult
} from '@shared/types'
import {
  cleanYouTubeMetadata,
  describeYouTubeRefusal,
  normalizeArtistName,
  parseYouTubeLink,
  youtubeChannelUrl,
  youtubeListTitle,
  youtubeListUrl,
  youtubeThumbnailCandidates,
  youtubeWatchUrl
} from '@shared/youtube'
import type { ArtworkService } from './artwork-service'

export interface OnlineService {
  /**
   * Every remembered link, newest activity first.
   *
   * A row whose cached thumbnail has been evicted reports no artwork rather than
   * a key that no longer resolves, so the view shows the placeholder instead of a
   * broken image.
   */
  list(): OnlineTrack[]
  /** Validates and resolves a pasted link, remembers it, and returns its row. */
  addLink(input: string): Promise<OnlineTrack>
  /** Records that a link has just been played. */
  touch(videoId: string): void
  /**
   * Records that an existing history row has been played, lifting it up the list.
   *
   * Never creates a row: the history is the set of links the user added, and a
   * playlist entry is not one of them. Playing a track from an imported list must
   * not echo it into the history, where the list already holds it.
   */
  rememberPlay(videoId: string): void
  remove(id: number): void
  /** Forgets every link. Returns how many were removed. */
  clear(): number
  /**
   * The cached cover for a history row, downloading it on the first ask.
   *
   * A stream track is not a `tracks` row, so the usual artwork lookup has nothing
   * to go on: it carries the negation of its history row's id, and this is where
   * that lookup lands. Fetching here rather than in `addLink` keeps a paste from
   * waiting on an image CDN, and it is what puts a picture on rows added while the
   * WebP thumbnails could not be decoded.
   */
  artworkFor(id: number): Promise<string | null>
  /**
   * The cached still for a video, whether or not it has a history row.
   *
   * A track imported from a playlist has no history row until it is played, so
   * `-id` cannot identify its artwork. This is the lookup for those rows: it
   * fetches by video id and also heals the history row if one exists.
   */
  artworkForVideo(videoId: string): Promise<string | null>
  /** Every imported playlist, most recently imported first. */
  playlists(): OnlinePlaylist[]
  /** One imported playlist with its entries, or null when it was deleted. */
  playlist(id: number): OnlinePlaylistDetail | null
  /**
   * Imports a playlist, album or mix and returns the stored snapshot.
   *
   * Importing the same list again replaces that playlist's entries in place. The
   * caller is responsible for queueing the returned items: an import never starts
   * playback by itself, so "add all to queue" and "play now" share one path.
   *
   * `limit` overrides the Settings count for this one import (1-1000). Re-import
   * is where a mix or radio gets a length the user picks; the setting remains the
   * default for every other import.
   */
  importList(input: string, limit?: number): Promise<OnlinePlaylistDetail>
  /**
   * Renames an imported playlist.
   *
   * The name is stored separately from YouTube's title, so a later re-import
   * refreshes the snapshot without undoing the rename.
   */
  renamePlaylist(id: number, title: string): OnlinePlaylist | null
  deletePlaylist(id: number): void
  removePlaylistItem(itemId: number): number | null
  /**
   * Searches YouTube for videos.
   *
   * Metadata only: a result is not remembered, downloaded or resolved, so the
   * search itself cannot fill the history or touch the library. Playing a result
   * goes through `addLink`, the same path a pasted link takes.
   */
  search(query: string, limit?: number, offset?: number): Promise<YouTubeSearchResult[]>
  /**
   * Lists a channel's recent videos.
   *
   * A channel link is accepted by id, handle or URL; a display name is not an
   * identity, so the view falls back to a search when it has only that.
   */
  channel(target: string, limit?: number): Promise<YouTubeChannel>
}

/** A thumbnail is decoration: cap each attempt so a hung CDN cannot stall a cover indefinitely. */
const THUMBNAIL_TIMEOUT_MS = 2_500
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024

/**
 * How many thumbnails are fetched at once.
 *
 * An imported album draws dozens of rows as soon as it opens; without a cap the
 * renderer would fire every artwork IPC in one tick and YouTube's CDN would see a
 * burst. Four at a time keeps the list filling in without looking like a scraper.
 */
const MAX_ARTWORK_DOWNLOADS = 4

/**
 * The Online history and the playlists imported from links.
 *
 * Playback is not this service's job — it only warms the resolver cache on the
 * way through, so pressing play on the row right after pasting is instant. Saving
 * a row to the library is the download service's job, next to this one.
 */
export function createOnlineService(deps: {
  resolver: YouTubeResolver
  repo: OnlineRepository
  playlists: OnlinePlaylistRepository
  /**
   * The flat listing provider. Repeated here rather than reached through the
   * resolver because importing is a different read: no formats, no stream URLs.
   */
  listProvider: YtPlaylistProvider
  /** Search and channel listings, kept separate from playback resolves. */
  discoverProvider: YtSearchProvider
  engine: () => EngineSettings
  artwork: ArtworkService
  log: Logger
  /** Called after any change, so the main process can push a refresh. */
  onChange?: () => void
  now?: () => number
}): OnlineService {
  const withArtwork = (entry: OnlineTrack): OnlineTrack => {
    if (!entry.artworkKey) return entry
    return deps.artwork.pathFor(entry.artworkKey) ? entry : { ...entry, artworkKey: null }
  }

  const withCover = (playlist: OnlinePlaylist): OnlinePlaylist => {
    if (!playlist.coverKey) return playlist
    return deps.artwork.pathFor(playlist.coverKey) ? playlist : { ...playlist, coverKey: null }
  }

  /**
   * Thumbnail downloads in flight, keyed by video.
   *
   * A row is drawn in the history and again in the player bar, and the same link
   * can be playing while its row is on screen, so without this the same picture
   * would be fetched twice.
   */
  const pendingArtwork = new Map<string, Promise<string | null>>()

  /**
   * Keys fetched during this session for tracks that may have no history row.
   *
   * Only successes are remembered: a failed fetch is usually the network, and a
   * session-long "no picture" verdict would be wrong the moment it recovers.
   */
  const videoArtwork = new Map<string, string>()

  let activeDownloads = 0
  const waitingDownloads: Array<() => void> = []

  const withDownloadSlot = async <T>(work: () => Promise<T>): Promise<T> => {
    if (activeDownloads >= MAX_ARTWORK_DOWNLOADS) {
      // The slot is handed over by the finishing download rather than released and
      // re-taken, so two waiters cannot both wake up for one freed slot.
      await new Promise<void>((resolve) => waitingDownloads.push(resolve))
    } else {
      activeDownloads += 1
    }
    try {
      return await work()
    } finally {
      const next = waitingDownloads.shift()
      if (next) next()
      else activeDownloads -= 1
    }
  }

  const downloadArtwork = (videoId: string): Promise<string | null> => {
    const existing = pendingArtwork.get(videoId)
    if (existing) return existing
    const work = withDownloadSlot(() => cacheThumbnail(videoId, deps.artwork, deps.log)).finally(() =>
      pendingArtwork.delete(videoId)
    )
    pendingArtwork.set(videoId, work)
    return work
  }

  const detailOf = (id: number): OnlinePlaylistDetail | null => {
    const playlist = deps.playlists.get(id)
    if (!playlist) return null
    return { playlist: withCover(playlist), items: deps.playlists.items(id) }
  }

  return {
    list() {
      return deps.repo.list().map(withArtwork)
    },

    async addLink(input) {
      // Validation and resolution live in the resolver, so a bad link is refused
      // with the same message the player already knows how to show.
      const link = await deps.resolver.resolveLink(input)
      const metadata = cleanYouTubeMetadata(link.track.title, link.track.artist)

      const entry = deps.repo.upsert(
        {
          videoId: link.track.sourceId,
          title: metadata.title,
          artist: metadata.artist,
          // Album fields arrive with playlist/album import (M5). A single watch
          // link carries no album, and inventing one would be worse than null.
          album: null,
          durationMs: link.track.durationMs,
          sourceUrl: youtubeWatchUrl(link.track.sourceId),
          // Left null: the cover is fetched the first time the row is drawn, so a
          // slow image CDN never holds up the row appearing after the resolve.
          artworkKey: null
        },
        deps.now?.() ?? Date.now()
      )
      deps.onChange?.()
      // A re-paste keeps the cover cached by the earlier row, so the answer still
      // goes through the missing-file check that `list()` applies.
      return withArtwork(entry)
    },

    async artworkFor(id) {
      const entry = deps.repo.get(id)
      if (!entry) return null
      if (entry.artworkKey && deps.artwork.pathFor(entry.artworkKey)) return entry.artworkKey

      const key = await downloadArtwork(entry.videoId)
      if (key) {
        videoArtwork.set(entry.videoId, key)
        deps.repo.setArtworkKey(entry.videoId, key)
        deps.onChange?.()
      }
      return key
    },

    async artworkForVideo(videoId) {
      const known = videoArtwork.get(videoId)
      if (known && deps.artwork.pathFor(known)) return known

      // A played track has a history row, and its cached key is the cheapest hit.
      const entry = deps.repo.getByVideoId(videoId)
      if (entry?.artworkKey && deps.artwork.pathFor(entry.artworkKey)) {
        videoArtwork.set(videoId, entry.artworkKey)
        return entry.artworkKey
      }

      const key = await downloadArtwork(videoId)
      if (!key) return null

      videoArtwork.set(videoId, key)
      if (entry) {
        deps.repo.setArtworkKey(videoId, key)
        deps.onChange?.()
      }
      return key
    },

    touch(videoId) {
      deps.repo.touch(videoId, deps.now?.() ?? Date.now())
      deps.onChange?.()
    },

    rememberPlay(videoId) {
      // No row means this was never a link the user added: an imported entry, a
      // saved copy, or a queue row left over from a list. There is nothing
      // truthful to write, and writing it would bury the real history.
      if (!deps.repo.getByVideoId(videoId)) return
      deps.repo.touch(videoId, deps.now?.() ?? Date.now())
      deps.onChange?.()
    },

    remove(id) {
      deps.repo.remove(id)
      deps.onChange?.()
    },

    clear() {
      const removed = deps.repo.clear()
      if (removed > 0) deps.onChange?.()
      return removed
    },

    playlists() {
      return deps.playlists.list().map(withCover)
    },

    playlist(id) {
      return detailOf(id)
    },

    async importList(input, requestedLimit) {
      const link = parseYouTubeLink(input)
      if (link.kind === 'refused') throw new Error(describeYouTubeRefusal(link.reason))
      if (link.kind === 'video') {
        throw new Error('That is a single video. Paste a playlist, album or mix link to import all of it.')
      }

      const kind = link.listKind
      const engine = deps.engine()
      // The cap is a setting, not a constant: a mix is endless and a playlist can
      // be 5,000 entries, and the right number depends on how the user listens.
      // A count typed beside Re-import overrides it for that one refresh.
      const fallback = Math.max(1, kind === 'mix' ? engine.mixLimit : engine.importLimit)
      const limit =
        requestedLimit === undefined || !Number.isFinite(requestedLimit)
          ? fallback
          : Math.max(1, Math.min(1000, Math.round(requestedLimit)))
      const sourceUrl = youtubeListUrl(link.listId)
      const info = await deps.listProvider.fetchPlaylist(sourceUrl, limit)

      const title = youtubeListTitle(info.title, kind) || link.listId
      // Albums often name no uploader on the list itself; the tracks all carry the
      // album artist, so the most common one is the honest fallback.
      const owner = info.owner ?? commonArtist(info.entries)
      // Only an album has a real sleeve at its list id. A playlist's thumbnails are
      // the first video's stills — a 120x90 crop that looks like a mistake blown up
      // to a cover — and a mix has none. Those two use per-track stills instead.
      const coverKey = kind === 'album' ? await cacheCover(info.coverUrls, deps.artwork, deps.log) : null

      if (info.entries.length === 0) {
        throw new Error('This list is empty, or every track in it is unavailable.')
      }

      const stored = deps.playlists.upsert(
        {
          listId: link.listId,
          kind,
          title,
          owner,
          sourceUrl,
          coverKey,
          totalCount: info.total
        },
        info.entries.map((entry) => {
          const fallbackArtist = normalizeArtistName(entry.artist) ?? (kind === 'album' ? owner : null)
          const metadata = cleanYouTubeMetadata(entry.title, fallbackArtist)
          return {
            videoId: entry.videoId,
            title: metadata.title,
            // In an album every row is by the album artist and belongs to the album;
            // in a playlist the uploader is the best artist we have and it has none.
            artist: metadata.artist,
            album: kind === 'album' ? title : null,
            durationMs: entry.durationMs
          }
        }),
        deps.now?.() ?? Date.now()
      )

      // This list is now the home for these tracks. Any history row a play had
      // already created for one of them is an echo of the same song, so it goes —
      // importing a list never leaves copies of its entries in the history.
      const removed = deps.repo.removeByVideoIds(info.entries.map((entry) => entry.videoId))
      if (removed > 0) deps.log.info('import took echoes out of the history', { listId: link.listId, removed })

      deps.onChange?.()
      return { playlist: withCover(stored), items: deps.playlists.items(stored.id) }
    },

    deletePlaylist(id) {
      if (deps.playlists.delete(id)) deps.onChange?.()
    },

    renamePlaylist(id, title) {
      const name = title.trim()
      if (name.length === 0 || name.length > 120) {
        throw new Error('A playlist name needs 1–120 characters.')
      }
      const renamed = deps.playlists.rename(id, name)
      if (!renamed) return null
      deps.onChange?.()
      return withCover(renamed)
    },

    removePlaylistItem(itemId) {
      const playlistId = deps.playlists.removeItem(itemId)
      if (playlistId !== null) deps.onChange?.()
      return playlistId
    },

    async search(query, requestedLimit, requestedOffset) {
      const text = query.trim()
      if (text.length === 0) throw new Error('Type something to search for.')
      if (text.length > 200) throw new Error('That search is too long.')
      const limit = Math.max(1, Math.min(50, Math.round(requestedLimit ?? 10)))
      const offset = Math.max(0, Math.min(490, Math.round(requestedOffset ?? 0)))
      const results = await deps.discoverProvider.search(text, limit, offset)
      return results.map((entry) => {
        const metadata = cleanYouTubeMetadata(entry.title, entry.artist)
        return { ...entry, title: metadata.title, artist: metadata.artist }
      })
    },

    async channel(target, requestedLimit) {
      const limit = Math.max(1, Math.min(50, Math.round(requestedLimit ?? 30)))
      const clean = (entries: YouTubeSearchResult[]): YouTubeSearchResult[] =>
        entries.map((entry) => {
          const metadata = cleanYouTubeMetadata(entry.title, entry.artist)
          return { ...entry, title: metadata.title, artist: metadata.artist }
        })

      const channelUrl = youtubeChannelUrl(target)
      if (!channelUrl) {
        // A search result usually carries a channel id or handle, but YouTube
        // sometimes only reports a display name. There is no page to point at in
        // that case, so the honest fallback is a search for the name; the view
        // says it is a channel and still lets every row play.
        const entries = clean(await deps.discoverProvider.search(target, limit))
        if (entries.length === 0) {
          throw new Error('No videos were found for that channel.')
        }
        return { channelId: null, name: target, url: '', entries }
      }

      const info = await deps.discoverProvider.channel(target, limit)
      if (info.entries.length === 0) {
        throw new Error('This channel has no public videos that this app can list.')
      }
      return { ...info, entries: clean(info.entries) }
    }
  }
}

/** The artist most entries share, used when a list names no uploader. */
function commonArtist(entries: ReadonlyArray<{ artist: string | null }>): string | null {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (!entry.artist) continue
    counts.set(entry.artist, (counts.get(entry.artist) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [artist, count] of counts) {
    if (count > bestCount) {
      best = artist
      bestCount = count
    }
  }
  return best
}

/**
 * Downloads an album's sleeve into the artwork cache.
 *
 * The largest still is frequently a 404 placeholder, so the candidates are walked
 * in order and the first that answers with real image bytes wins. Callers only ask
 * for albums: a playlist's "cover" is one video's 16:9 still, not a sleeve.
 */
async function cacheCover(urls: readonly string[], artwork: ArtworkService, log: Logger): Promise<string | null> {
  for (const url of urls) {
    const key = await fetchImage(url, artwork, log)
    if (key) return key
  }
  return null
}

/**
 * Downloads the best still for a video into the artwork cache.
 *
 * Best effort on purpose: a row is still worth having without a picture, so a
 * timeout, a 404 or an image this build cannot decode just leaves the key null
 * rather than failing the request. The candidate list exists because the WebP
 * still that `yt-dlp` reports cannot be decoded by Electron's `nativeImage`; the
 * caller walks the JPEG variants until one sticks.
 */
async function cacheThumbnail(videoId: string, artwork: ArtworkService, log: Logger): Promise<string | null> {
  for (const url of youtubeThumbnailCandidates(videoId)) {
    const key = await fetchImage(url, artwork, log)
    if (key) return key
  }
  return null
}

/** One candidate: fetched, size-checked and decoded, or null. */
async function fetchImage(url: string, artwork: ArtworkService, log: Logger): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(THUMBNAIL_TIMEOUT_MS) })
    // A missing `maxresdefault` is not a clean 404: YouTube answers with a
    // decodable 120x90 placeholder and a failing status, so the status matters.
    if (!response.ok) return null

    const mime = response.headers.get('content-type') ?? ''
    if (!mime.startsWith('image/')) return null

    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_THUMBNAIL_BYTES) return null

    const data = Buffer.from(await response.arrayBuffer())
    if (data.length === 0 || data.length > MAX_THUMBNAIL_BYTES) return null

    // `cacheRemote` returns null when the bytes do not decode, which is what lets
    // the caller fall through to the next candidate.
    return await artwork.cacheRemote(data, mime)
  } catch (error) {
    log.debug('thumbnail could not be cached', { error })
    return null
  }
}
