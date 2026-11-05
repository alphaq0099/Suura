import type { CookieFallbackMode, EngineSettings, QualityTier } from './types'

/**
 * YouTube link handling and yt-dlp argument policy.
 *
 * Kept in `shared/` because the renderer validates the same links before it
 * sends them, and because smoke tests can cover the rules without a sidecar or
 * a network. Nothing here imports Node or Electron.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

/**
 * Browsers yt-dlp can read cookies from on Windows.
 *
 * Cookies are off by default. This list exists so the setting can name the
 * browsers that are actually supported and so the main process can reject a
 * hand-edited config that asks for something else.
 */
export const COOKIE_BROWSERS = ['chrome', 'edge', 'firefox', 'brave', 'chromium', 'opera', 'vivaldi'] as const

export type CookieBrowser = (typeof COOKIE_BROWSERS)[number]

export function isSupportedCookieBrowser(value: unknown): value is CookieBrowser {
  return typeof value === 'string' && (COOKIE_BROWSERS as readonly string[]).includes(value)
}

/**
 * Browsers whose Windows cookie store yt-dlp may fail to decrypt.
 *
 * Chrome 127 and later, and current Edge, encrypt cookies with App-Bound
 * Encryption, which yt-dlp cannot read (yt-dlp issue 10927). The list is
 * deliberately only these two: the other Chromium builds keep the older
 * protection, so warning about them would be a guess.
 */
export const APP_BOUND_COOKIE_BROWSERS = ['chrome', 'edge'] as const

export function usesAppBoundEncryption(value: string | null | undefined): boolean {
  return typeof value === 'string' && (APP_BOUND_COOKIE_BROWSERS as readonly string[]).includes(value)
}

/**
 * The cookie fallback policy, kept next to the argument builders so the main
 * process, the settings UI and the smoke tests all agree on the allowed values.
 */
export const COOKIE_FALLBACKS = ['off', 'on-bot-check', 'always'] as const

export function isCookieFallbackMode(value: unknown): value is CookieFallbackMode {
  return typeof value === 'string' && (COOKIE_FALLBACKS as readonly string[]).includes(value)
}

/**
 * Cleans a browser profile name without destroying spaces or Windows path
 * separators. yt-dlp accepts `browser:profile`, so newlines and NUL are the
 * only characters that must never reach the argument.
 */
export function normalizeCookieBrowserProfile(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 200 || /[\r\n\0]/.test(trimmed)) return null
  return trimmed
}

/**
 * Validates a path to an exported cookies file.
 *
 * Only absolute paths are kept: a relative one would silently depend on the
 * directory the app happened to start in. The file itself is read by yt-dlp,
 * never copied into the app's data folder, so it stays under the user's
 * control and can be revoked by deleting it.
 */
export function normalizeCookiesFile(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 4096 || /[\r\n\0]/.test(trimmed)) return null
  if (!/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(trimmed)) return null
  return trimmed
}

/**
 * Adds an exported cookies file to a yt-dlp call.
 *
 * Kept next to `withBrowserCookies` so every builder applies the same rule.
 * The caller decides when cookies are used; this function only decides how.
 */
export function withCookiesFile(args: readonly string[], file: string | null | undefined): string[] {
  const cleaned = normalizeCookiesFile(file)
  if (!cleaned) return [...args]
  const cookieArgs = ['--cookies', cleaned]
  if (args[0] === '--ignore-config') return [args[0], ...cookieArgs, ...args.slice(1)]
  return [...cookieArgs, ...args]
}

/**
 * Adds the opt-in cookie argument to a yt-dlp call.
 *
 * The argument never appears unless the user chose a browser in Settings. It is
 * kept here rather than in each builder so search, resolve, imports and saves
 * all use exactly the same policy. The profile is optional; without it yt-dlp
 * reads the browser's default profile.
 */
export function withBrowserCookies(
  args: readonly string[],
  browser: string | null | undefined,
  profile?: string | null
): string[] {
  if (!isSupportedCookieBrowser(browser)) return [...args]
  const cleanedProfile = normalizeCookieBrowserProfile(profile)
  const source = cleanedProfile ? `${browser}:${cleanedProfile}` : browser
  const cookieArgs = ['--cookies-from-browser', source]
  // Keep `--ignore-config` first: it is the promise that a local yt-dlp config
  // cannot change what this app does. The cookie switch is still explicit.
  if (args[0] === '--ignore-config') return [args[0], ...cookieArgs, ...args.slice(1)]
  return [...cookieArgs, ...args]
}

/** The provider plugin's default local endpoint. */
export const DEFAULT_PO_TOKEN_PROVIDER_URL = 'http://127.0.0.1:4416'

/** The extractor-args namespace used by bgutil's HTTP provider plugin. */
export const PO_TOKEN_EXTRACTOR_ARGS = 'youtubepot-bgutilhttp'

/**
 * Validates and normalises a provider base URL.
 *
 * Query strings, fragments and credentials are rejected because the plugin
 * appends its own paths to this value. An empty or invalid value becomes null,
 * and callers fall back to the documented local default.
 */
export function normalizePoTokenProviderUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 2048) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password || url.search || url.hash) return null
    return url.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

/**
 * Points yt-dlp's bgutil HTTP plugin at the configured provider.
 *
 * The app deliberately does not ship the plugin or the provider: this only adds
 * the extractor argument when the user has enabled the feature. If the plugin
 * is absent yt-dlp reports its own warning, which is visible in the log.
 */
export function withPoTokenProvider(args: readonly string[], engine: EngineSettings): string[] {
  if (!engine.poTokenEnabled) return [...args]
  const url = normalizePoTokenProviderUrl(engine.poTokenProviderUrl) ?? DEFAULT_PO_TOKEN_PROVIDER_URL
  const providerArgs = ['--extractor-args', `${PO_TOKEN_EXTRACTOR_ARGS}:base_url=${url}`]
  // Keep `--ignore-config` first for the same reason as the cookie switch.
  if (args[0] === '--ignore-config') return [args[0], ...providerArgs, ...args.slice(1)]
  return [...providerArgs, ...args]
}

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

/**
 * The URL that lists a channel's videos.
 *
 * A search result carries a channel id (`UC…`), a handle (`@name`) or sometimes
 * only the display name. Only the first two are identities; a display name is
 * not something yt-dlp can be pointed at without searching for it first, so the
 * caller falls back to the search route in that case.
 */
export function youtubeChannelUrl(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null

  if (/^UC[\w-]{22}$/.test(trimmed)) {
    return `https://www.youtube.com/channel/${trimmed}/videos`
  }
  if (/^@[\w.-]+$/.test(trimmed)) {
    return `https://www.youtube.com/${trimmed}/videos`
  }

  let url: URL
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (!YOUTUBE_HOSTS.has(host)) return null

  const parts = url.pathname.split('/').filter(Boolean)
  const first = parts[0] ?? ''
  const second = parts[1] ?? ''
  if (first === 'channel' && /^UC[\w-]{22}$/.test(second)) {
    return `https://www.youtube.com/channel/${second}/videos`
  }
  if (first.startsWith('@')) return `https://www.youtube.com/${first}/videos`
  if ((first === 'c' || first === 'user') && second) {
    return `https://www.youtube.com/${first}/${second}/videos`
  }
  return null
}

/**
 * Turns a YouTube title into the title a music library would use.
 *
 * Uploads carry marketing decoration that is not part of the song: brackets
 * around "Official Video", "Lyrics" or "4K", and a `Artist - ` prefix that only
 * repeats the channel. Both are stripped only when the pattern is unambiguous;
 * "(Live)" is deliberately kept, because that is a different recording, not
 * decoration. Exported because the rules are worth testing without a sidecar.
 */
export function cleanYouTubeMetadata(
  title: string,
  artist: string | null | undefined
): { title: string; artist: string | null } {
  const noise =
    /\s*[\[(](?:official\s+(?:music\s+)?video|official\s+audio|official\s+lyric\s+video|lyric\s+video|lyrics?|audio|visuali[sz]er|music\s+video|m\/v|mv|hd|hq|4k|8k|explicit|clean|remaster(?:ed)?(?:\s+\d{4})?)[\])]/gi
  let cleaned = title
    .replace(noise, ' ')
    .replace(/\s*[|•]\s*(?:official\s+)?(?:music\s+)?video\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (cleaned.length === 0) cleaned = title.trim()

  const name = normalizeArtistName(artist)
  if (!name) return { title: cleaned, artist: null }

  const prefix = new RegExp(`^${escapeRegExp(name)}\\s*[-–—:]\\s*`, 'i')
  const withoutArtist = cleaned.replace(prefix, '').trim()
  if (withoutArtist.length >= 2 && withoutArtist !== cleaned) {
    return { title: withoutArtist, artist: name }
  }
  return { title: cleaned, artist: name }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
 * favourites and a channel's uploads - all of which belong to a signed-in
 * account. This app does not sign in, so those lists are refused even when the
 * optional browser-cookie setting is on.
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
 * The refusals are product decisions, not errors: account lists belong to a
 * signed-in account, and picking one video out of a channel page is not an
 * import.
 */
export function describeYouTubeRefusal(reason: YouTubeRefusal): string {
  switch (reason) {
    case 'account-list':
      return 'Liked videos, Watch Later and channel uploads belong to a YouTube account. This app does not sign in, so it cannot read them. Import a playlist, album or mix instead.'
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
 * Whether a failure looks like YouTube's automated-traffic challenge.
 *
 * Kept separate from the human message so the circuit breaker and the retry
 * policy can agree on what is not retryable.
 */
export function isYouTubeBotCheck(stderr: string): boolean {
  const text = stderr.toLowerCase()
  // Deliberately narrower than "mentions cookies": a failed browser-cookie
  // read is a configuration error, not a challenge, and must not pause the app.
  return /sign in to confirm.*not a bot|confirm you(?:'re| are|\u2019re) not a bot|not a bot|automated traffic|unusual traffic|too many requests|http error 429/.test(
    text
  )
}

/**
 * A transient network failure that is safe to retry once.
 *
 * Bot checks, age restrictions, unavailable videos and bad links are excluded:
 * retrying those only spends another request, and for a bot check it makes the
 * next challenge more likely.
 */
export function isRetryableYouTubeFailure(stderr: string): boolean {
  if (isYouTubeBotCheck(stderr)) return false
  const text = stderr.toLowerCase()
  return /connection reset|econnreset|socket timeout|temporarily unavailable|http error 5\d\d|unable to download webpage|network is unreachable|eai_again|enotfound|getaddrinfo/.test(
    text
  )
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
  // A cookie store that cannot be decrypted is a configuration failure, not a
  // challenge, so it is described before the bot-check patterns. Chrome and
  // Edge encrypt cookies with App-Bound Encryption on Windows, which yt-dlp
  // cannot read (yt-dlp issue 10927); Firefox is the local workaround.
  if (/failed to decrypt with dpapi|decrypt with dpapi/.test(text)) {
    return 'The browser cookies could not be read: Chrome and Edge encrypt their cookie store in a way yt-dlp cannot decrypt on Windows. Choose Firefox in Settings → Streaming, or turn the cookie fallback off and use a PO Token provider.'
  }
  // Chrome holds an exclusive lock on its cookie database while it runs, so
  // yt-dlp cannot even copy it (issue 7271). That is a different failure from
  // a decryption problem and has a different fix.
  if (/could not copy .*cookie database/.test(text)) {
    return 'The browser cookies could not be read while Chrome is open, because Chrome locks its cookie database. Close Chrome and try again, or choose Firefox in Settings → Streaming.'
  }
  // A 429 is a rate limit. The gate still pauses requests because
  // isYouTubeBotCheck matches it, but the message should name the real cause.
  if (/http error 429|too many requests/.test(text)) {
    return 'YouTube is rate-limiting requests from this network (HTTP 429). New YouTube requests pause for a few minutes; if it keeps happening, wait longer or try another network.'
  }
  if (isYouTubeBotCheck(stderr)) {
    return 'YouTube is checking this request for automated traffic. New YouTube requests pause for a few minutes after this. The app does not sign in; a PO Token provider or the opt-in cookie fallback in Streaming settings may help.'
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
