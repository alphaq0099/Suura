import type { QualityTier } from './types'

/**
 * YouTube link handling and yt-dlp argument policy.
 *
 * Kept in `shared/` because the renderer validates the same links before it
 * sends them, and because smoke tests can cover the rules without a sidecar or
 * a network. Nothing here imports Node or Electron.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

export function isYouTubeVideoId(value: string): boolean {
  return VIDEO_ID.test(value)
}

/**
 * Extracts the video id from the forms people actually paste.
 *
 * A playlist link without a video gets null rather than the first video in the
 * list: "Paste a video link" is the feature, and silently picking a video from
 * a 400-item playlist is not something the user asked for.
 */
export function extractYouTubeVideoId(input: string): string | null {
  const trimmed = input.trim()
  if (VIDEO_ID.test(trimmed)) return trimmed

  let url: URL
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] ?? ''
    return VIDEO_ID.test(id) ? id : null
  }
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'music.youtube.com') return null

  const fromQuery = url.searchParams.get('v') ?? ''
  if (VIDEO_ID.test(fromQuery)) return fromQuery

  const parts = url.pathname.split('/').filter(Boolean)
  const [first, second] = parts
  if (first && second && ['shorts', 'embed', 'live', 'v'].includes(first) && VIDEO_ID.test(second)) {
    return second
  }
  return null
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}

export function youtubePlaylistUrl(listId: string): string {
  return `https://www.youtube.com/playlist?list=${listId}`
}

/**
 * The URL to hand yt-dlp for a list.
 *
 * A radio mix's id is `RD` + its seed video, and the shape that actually returns
 * a queue is the watch URL with `start_radio=1` — the bare playlist URL can come
 * back as a single video. Everything else uses the plain playlist form.
 */
export function youtubeListUrl(listId: string): string {
  if (listId.startsWith('RD')) {
    const seed = listId.slice(2)
    if (isYouTubeVideoId(seed)) {
      return `https://www.youtube.com/watch?v=${seed}&list=${listId}&start_radio=1`
    }
  }
  return youtubePlaylistUrl(listId)
}

/** What a `list=` id is. `account` means it belongs to a signed-in account. */
export type YouTubeListKind = 'playlist' | 'album' | 'mix'

export type YouTubeRefusal = 'account-list' | 'channel' | 'not-youtube'

/**
 * What a pasted link means.
 *
 * Kept as a union rather than a bag of nullable fields so every caller has to
 * decide what it does with a channel page or a Liked-videos list — there is no
 * "videoId and maybe a list" shape to forget about.
 */
export type YouTubeLink =
  | { kind: 'video'; videoId: string }
  /** A video that happens to sit in a playlist. Playing the video still does. */
  | { kind: 'video-in-list'; videoId: string; listId: string; listKind: 'playlist' | 'album' }
  | { kind: 'list'; listId: string; listKind: YouTubeListKind }
  | { kind: 'refused'; reason: YouTubeRefusal }

const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com'])

/**
 * The prefix of a list id, when it is one this app recognises.
 *
 * `OLAK5uy_` is YouTube Music's auto-generated album list, `RD` is a radio/mix.
 * `LL`/`WL`/`FL`/`UU`/`UL` are the account's liked videos, watch later,
 * favourites and a channel's uploads — all of which need the signed-in account's
 * cookies, which this app deliberately never reads.
 */
export function explicitListKind(listId: string): YouTubeListKind | 'account' | null {
  const id = listId.startsWith('VL') ? listId.slice(2) : listId
  if (id.length < 2) return null
  if (id.startsWith('OLAK5uy_')) return 'album'
  if (id.startsWith('RD')) return 'mix'
  if (id.startsWith('PL')) return 'playlist'
  if (/^(LL|WL|FL|UU|UL)/.test(id)) return 'account'
  return null
}

/**
 * What to tell someone whose link cannot be imported.
 *
 * The refusals are product decisions, not errors: account lists need cookies the
 * app never reads, and picking one video out of a channel page is not an import.
 */
export function describeYouTubeRefusal(reason: YouTubeRefusal): string {
  switch (reason) {
    case 'account-list':
      return 'Liked videos, Watch Later and channel uploads belong to a YouTube account. This app never signs in, so it cannot read them. Import a playlist, album or mix instead.'
    case 'channel':
      return 'That is a channel page, not a playlist. Open one of its playlists and paste that link.'
    default:
      return 'That does not look like a YouTube link.'
  }
}

function videoIdFrom(url: URL): string | null {
  const fromQuery = url.searchParams.get('v') ?? ''
  if (VIDEO_ID.test(fromQuery)) return fromQuery

  const parts = url.pathname.split('/').filter(Boolean)
  const [first, second] = parts
  if (first && second && ['shorts', 'embed', 'live', 'v'].includes(first) && VIDEO_ID.test(second)) {
    return second
  }
  return null
}

/**
 * Classifies a pasted link without touching the network.
 *
 * A mix wins over its seed video: `watch?v=…&list=RD…&start_radio=1` is a radio
 * station whose `v=` is only the seed, so the useful action is importing the mix,
 * not playing one track. A `PL…` list with a `v=` is the other way round — the
 * user clicked a song, so the video plays and the import is offered separately.
 */
export function parseYouTubeLink(input: string): YouTubeLink {
  const trimmed = input.trim()
  if (trimmed.length === 0) return { kind: 'refused', reason: 'not-youtube' }

  // A bare id, or a bare list id: neither has a path or a query.
  if (!/[/?.]/.test(trimmed)) {
    if (isYouTubeVideoId(trimmed)) return { kind: 'video', videoId: trimmed }
    const bare = explicitListKind(trimmed)
    if (bare && bare !== 'account' && trimmed.length > 11) {
      return { kind: 'list', listId: trimmed, listKind: bare }
    }
    return { kind: 'refused', reason: 'not-youtube' }
  }

  let url: URL
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  } catch {
    return { kind: 'refused', reason: 'not-youtube' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { kind: 'refused', reason: 'not-youtube' }
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] ?? ''
    if (!VIDEO_ID.test(id)) return { kind: 'refused', reason: 'not-youtube' }
    const listId = url.searchParams.get('list') ?? ''
    const kind = listId ? explicitListKind(listId) : null
    if (kind === 'account') return { kind: 'refused', reason: 'account-list' }
    if (kind === 'mix') return { kind: 'list', listId, listKind: 'mix' }
    if (kind) return { kind: 'video-in-list', videoId: id, listId, listKind: kind }
    return { kind: 'video', videoId: id }
  }

  if (!YOUTUBE_HOSTS.has(host)) return { kind: 'refused', reason: 'not-youtube' }

  const parts = url.pathname.split('/').filter(Boolean)
  const first = parts[0] ?? ''
  if (first.startsWith('@') || ['channel', 'c', 'user'].includes(first)) {
    return { kind: 'refused', reason: 'channel' }
  }

  const listId = url.searchParams.get('list') ?? ''
  if (listId) {
    const kind = explicitListKind(listId) ?? 'playlist'
    if (kind === 'account') return { kind: 'refused', reason: 'account-list' }
    if (kind === 'mix') return { kind: 'list', listId, listKind: 'mix' }

    const videoId = videoIdFrom(url)
    if (videoId) return { kind: 'video-in-list', videoId, listId, listKind: kind }
    return { kind: 'list', listId, listKind: kind }
  }

  const videoId = videoIdFrom(url)
  if (videoId) return { kind: 'video', videoId }
  return { kind: 'refused', reason: 'not-youtube' }
}

/**
 * Cleans the names YouTube gives a list.
 *
 * An album arrives as `"Album - head or heart"` and a mix as `"Mix - …"`; both
 * prefix is plumbing, not a title. A hand-made playlist keeps whatever it was
 * called, even if that happens to start with "Mix".
 */
export function youtubeListTitle(title: string, kind: YouTubeListKind): string {
  const trimmed = title.trim()
  if (kind === 'playlist') return trimmed
  const prefix = kind === 'album' ? /^album\s*[-:]\s*/i : /^mix\s*[-:]\s*/i
  const stripped = trimmed.replace(prefix, '').trim()
  return stripped.length > 0 ? stripped : trimmed
}

/**
 * Drops YouTube's auto-generated `" - Topic"` suffix.
 *
 * Official artist channels are named `"Christina Perri - Topic"`; the suffix is
 * YouTube's, not the artist's, and it reads as a bug in every row it appears in.
 */
export function normalizeArtistName(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const stripped = trimmed.replace(/\s*-\s*topic$/i, '').trim()
  return stripped.length > 0 ? stripped : trimmed
}

/**
 * Still-image URLs for a video, best first.
 *
 * `yt-dlp -J` reports the thumbnail as `i.ytimg.com/vi_webp/…/maxresdefault.webp`,
 * and Electron's `nativeImage` cannot decode WebP — it returns an *empty* image
 * rather than an error, so the cover silently went missing. YouTube publishes the
 * same stills as JPEG under `vi/`, so those are what this app asks for.
 *
 * Both entries are true 16:9 stills. `hqdefault` and `sddefault` are deliberately
 * left out even though they are bigger than `mqdefault`: YouTube renders them 4:3
 * with black bars above and below a widescreen frame, and the app crops covers to
 * a square, which would bake those bars into the artwork.
 *
 * `maxresdefault` only exists for uploads that were at least 720p, and a missing
 * one answers **404 with a decodable 120x90 placeholder body** rather than
 * nothing, so the caller has to check the status as well as the decode. Deriving
 * the URLs from the video id rather than from the resolved link also means a row
 * can be given its cover later without resolving the video again.
 */
export function youtubeThumbnailCandidates(videoId: string): string[] {
  if (!isYouTubeVideoId(videoId)) return []
  return [
    `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
  ]
}

/**
 * The format string for a quality tier.
 *
 * `bestaudio` is audio-only, which is what this app plays; the `/best` fallback
 * matters because a small number of uploads only exist as a muxed file. An
 * <audio> element plays the audio track of a muxed mp4 perfectly well, so the
 * alternative would be refusing to play those videos at all.
 *
 * Tiers are advisory: yt-dlp falls through the list, so a video that cannot
 * satisfy a bitrate cap still plays at the best quality it has.
 */
export function youtubeFormatSelector(tier: QualityTier): string {
  switch (tier) {
    case 'best':
      return 'bestaudio/best'
    case 'high':
      return 'bestaudio[abr>=128]/bestaudio/best'
    case 'balanced':
      return 'bestaudio[abr<=160]/bestaudio/best'
    case 'data-saver':
      return 'bestaudio[abr<=96]/bestaudio/best'
    default:
      return 'bestaudio/best'
  }
}

/**
 * Turns yt-dlp's stderr into something a person can act on.
 *
 * The raw text is logged, never shown: it contains URLs, absolute paths and
 * extractor internals. The patterns are deliberately loose because YouTube
 * rewords these messages regularly and a wrong guess is still better than
 * "Something went wrong".
 */
export function describeYouTubeFailure(stderr: string): string {
  const text = stderr.toLowerCase()
  if (/sign in to confirm|not a bot|confirm you're not a bot|cookies/.test(text)) {
    return 'YouTube asked for a sign-in check on this video. Try another link, or open this one in a browser first.'
  }
  if (/age.?restricted|confirm your age/.test(text)) {
    return 'This video is age-restricted, so it cannot be played here.'
  }
  if (/members.?only|join this channel/.test(text)) {
    return 'This video is only available to channel members.'
  }
  if (/private video|video unavailable|this video is not available|has been removed|account associated/.test(text)) {
    return 'This video is unavailable. It may be private, removed or blocked in your country.'
  }
  if (/live event|is_live|premieres in|live stream/.test(text)) {
    return 'Live streams are not supported yet.'
  }
  if (/timed out|timeout|etimedout|socket timeout/.test(text)) {
    return 'YouTube took too long to answer. Check the connection and try again.'
  }
  if (/getaddrinfo|enotfound|eai_again|network is unreachable|connection refused/.test(text)) {
    return 'Could not reach YouTube. Check the connection and try again.'
  }
  if (/unsupported url|not a valid url/.test(text)) {
    return 'That does not look like a YouTube video link.'
  }
  return 'Could not resolve that link. The video may be region-locked or the link may be wrong.'
}
