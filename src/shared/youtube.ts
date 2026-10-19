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
