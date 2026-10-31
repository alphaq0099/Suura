import type { LyricsCandidate, LyricsLookupQuery } from './types'
import { TAG_TEXT_LIMITS } from './tags'

/**
 * Reading Genius, which publishes lyrics as a page rather than an API.
 *
 * Genius has no keyless endpoint that returns lyrics: their API carries song
 * metadata and requires a token, and the words live in the song page's markup.
 * The finder therefore asks the public search endpoint their own site uses,
 * then reads the page for the few best hits. That is the same shape as any
 * page reader and it can change without notice, so every step is pure and
 * covered by `npm run smoke`; the network client in the main process only
 * supplies the bytes.
 *
 * Genius lyrics are plain text, never LRC, so they are a fallback for the
 * words rather than a timed source. The page URL travels with the match: their
 * terms ask for a link back, and the panel shows one.
 */

export const GENIUS_WEB_URL = 'https://genius.com'

/** The search endpoint Genius's own site calls. */
export const GENIUS_SEARCH_URL = `${GENIUS_WEB_URL}/api/search/multi`

/** How many search hits are worth opening; each one is a page request. */
export const GENIUS_PAGE_LIMIT = 3

export interface GeniusHit {
  providerId: string
  title: string
  artist: string
  url: string
  instrumental: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/** Only the site's own pages are ever fetched, whatever a payload claims. */
export function isGeniusUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (url.hostname === 'genius.com' || url.hostname === 'www.genius.com')
  } catch {
    return false
  }
}

/** The title without the bracketed noise a download often adds. */
function searchText(title: string): string {
  const cleaned = title
    .replace(/\((?:[^()]*)\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned.length > 0 ? cleaned : title.trim()).slice(0, 200)
}

export function geniusSearchUrl(query: LyricsLookupQuery): string {
  const url = new URL(GENIUS_SEARCH_URL)
  url.searchParams.set('per_page', String(GENIUS_PAGE_LIMIT))
  const artist = query.artist?.trim()
  url.searchParams.set(
    'q',
    artist && artist.length > 0 ? `${searchText(query.title)} ${artist.slice(0, 200)}` : searchText(query.title)
  )
  return url.toString()
}

/**
 * The song hits in a `/api/search/multi` payload.
 *
 * The endpoint groups results by kind and repeats the best one under
 * `top_hit`, so the same song can arrive twice. The provider id is the stable
 * answer to "is this the same page", and the first copy wins.
 */
export function geniusHits(payload: unknown): GeniusHit[] {
  const response = asRecord(asRecord(payload)?.response)
  const sections = Array.isArray(response?.sections) ? response.sections : []
  const out: GeniusHit[] = []
  const seen = new Set<string>()

  for (const section of sections) {
    const record = asRecord(section)
    const hits = Array.isArray(record?.hits) ? record.hits : []
    for (const hit of hits) {
      const entry = asRecord(hit)
      if (entry?.type !== 'song') continue
      const result = asRecord(entry.result)
      if (!result) continue
      if (result.instrumental === true) continue

      const title = asString(result.title)
      const url = asString(result.url)
      const id = result.id
      if (!title || title.length > 500 || !url || !isGeniusUrl(url)) continue
      if (typeof id !== 'number' && typeof id !== 'string') continue

      const providerId = String(id)
      if (seen.has(providerId)) continue
      seen.add(providerId)
      out.push({
        providerId,
        title,
        artist: asString(result.artist_names) ?? '',
        url,
        instrumental: false
      })
      if (out.length >= 8) return out
    }
  }
  return out
}

/** One hit as a candidate, before the page's words are attached. */
export function geniusCandidate(hit: GeniusHit, text: string): LyricsCandidate {
  return {
    provider: 'genius',
    providerId: hit.providerId,
    title: hit.title,
    artist: hit.artist,
    album: null,
    durationMs: null,
    synced: false,
    text,
    instrumental: hit.instrumental,
    url: hit.url,
    score: 0,
    confidence: 'weak'
  }
}

// ---- the page --------------------------------------------------------------

/**
 * The inner HTML of every element carrying `marker`.
 *
 * A regex cannot match nested `<div>`s, and Genius nests them, so this walks
 * the string and counts open and close tags of the same name. The result is
 * the element's contents without its own wrapper, in document order.
 */
function innerElements(source: string, marker: string): string[] {
  const out: string[] = []
  let index = 0
  while ((index = source.indexOf(marker, index)) >= 0) {
    const openStart = source.lastIndexOf('<', index)
    if (openStart < 0) break
    const openEnd = source.indexOf('>', index)
    if (openEnd < 0) break
    const tag = /^<([a-zA-Z0-9]+)/.exec(source.slice(openStart, openEnd + 1))?.[1]
    if (!tag) {
      index = openEnd + 1
      continue
    }
    // `<br/>` and friends cannot contain lyrics; skipping keeps the walk simple.
    if (source[openEnd - 1] === '/') {
      index = openEnd + 1
      continue
    }

    const openRe = new RegExp(`<${tag}(?=[\\s>/])`, 'gi')
    const closeRe = new RegExp(`</${tag}\\s*>`, 'gi')
    let depth = 1
    let cursor = openEnd + 1
    let closeStart = -1
    while (depth > 0) {
      openRe.lastIndex = cursor
      closeRe.lastIndex = cursor
      const nextOpen = openRe.exec(source)
      const nextClose = closeRe.exec(source)
      if (!nextClose) {
        closeStart = -1
        break
      }
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth += 1
        cursor = nextOpen.index + 1
      } else {
        depth -= 1
        if (depth === 0) closeStart = nextClose.index
        cursor = nextClose.index + 1
      }
    }
    if (closeStart < 0) break
    out.push(source.slice(openEnd + 1, closeStart))
    index = closeStart + 1
  }
  return out
}

const EXCLUDED_MARKERS = [
  'data-exclude-from-selection="true"',
  "data-exclude-from-selection='true'"
]

function stripExcluded(fragment: string): string {
  let text = fragment
  // A header may contain another excluded block, so a few passes are needed.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text
    for (const marker of EXCLUDED_MARKERS) {
      for (const inner of innerElements(text, marker)) {
        const at = text.indexOf(inner)
        if (at >= 0) text = text.slice(0, at) + text.slice(at + inner.length)
      }
    }
    if (text === before) break
  }
  return text
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number(dec)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Lines Genius adds around the words that are not lyrics. */
function isBoilerplate(line: string): boolean {
  return (
    line === 'You might also like' ||
    line === 'Embed' ||
    line === 'Read More' ||
    line === 'Show More' ||
    /^\d+ Contributors?$/.test(line)
  )
}

/**
 * The words from one song page.
 *
 * `<br>` is the line break in Genius markup; the rest of the tags only wrap
 * spans and annotation links, so stripping them leaves the text. The excluded
 * blocks carry contributor counts, translation menus and ads and are removed
 * before the tags, because their text is not lyrics.
 */
export function lyricsFromGeniusHtml(html: string): string | null {
  const source = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  const containers = innerElements(source, 'data-lyrics-container="true"')
  const parts: string[] = []
  for (const container of containers) {
    const text = decodeEntities(
      stripExcluded(container).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    )
    const lines = text
      .replace(/\u200b/g, '')
      .split('\n')
      .map((line) => line.replace(/\s+$/g, '').replace(/^\s+/g, ''))
      .filter((line) => !isBoilerplate(line))

    // A run of blank lines separates verses; more than one is markup, not text.
    const joined = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    if (joined.length > 0) parts.push(joined)
  }

  const lyrics = parts.join('\n\n').trim()
  if (lyrics.length === 0 || lyrics.length > TAG_TEXT_LIMITS.lyrics) return null
  return lyrics
}
