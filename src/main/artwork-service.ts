import { existsSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeImage, type NativeImage } from 'electron'
import { artworkKeyFor, extractArtwork } from '@core/library/artwork'
import type { TrackRepository } from '@core/library/track-repository'
import type { Logger } from '@core/logging/logger'
import type { AppPaths } from '@shared/types'

/** Longest edge of a cached cover. Album art is displayed at 44-56px. */
const MAX_ARTWORK_PX = 512

/** Shape of a key this service will hand back to the protocol handler. */
const ARTWORK_FILE = /^[0-9a-f]{40}\.(jpg|png|webp|gif|bmp)$/

export interface ArtworkService {
  /** Cache key for a track, or null when it has no embedded artwork. */
  resolve(trackId: number): Promise<string | null>
  /** Caches an image that did not come from a file (a remote thumbnail). */
  cacheRemote(data: Buffer, mime: string): Promise<string | null>
  /** Absolute path for a key, or null if it is not one of ours or has gone. */
  pathFor(key: string): string | null
  /** Where resized covers are written. Surfaced in Settings for debugging. */
  cacheDir: string
}

/**
 * Turns embedded cover art into small cached files.
 *
 * Extraction is lazy rather than part of the scan: reading a cover costs a
 * second parse of the file, and a library of 20 000 tracks has far more covers
 * than a user will ever look at. The three layers that keep it cheap are
 * - the database (`artwork_key`: null = not looked at, '' = none, else a file),
 * - this service (an album is parsed once, and concurrent callers share the work),
 * - the renderer (a track id is requested at most once per session).
 */
export function createArtworkService(deps: {
  repo: TrackRepository
  paths: AppPaths
  log: Logger
}): ArtworkService {
  const cacheDir = join(deps.paths.cache, 'artwork')
  mkdirSync(cacheDir, { recursive: true })

  /** In-flight extractions, keyed by album (or track, when there is no album). */
  const inFlight = new Map<string, Promise<string | null>>()

  const absoluteFor = (key: string): string | null =>
    ARTWORK_FILE.test(key) ? join(cacheDir, key) : null

  const cached = (key: string | null): boolean => {
    if (!key) return false
    const absolute = absoluteFor(key)
    return absolute !== null && existsSync(absolute)
  }

  const store = async (filePath: string): Promise<string | null> => {
    const artwork = await extractArtwork(filePath)
    if (!artwork) return null

    const image = nativeImage.createFromBuffer(Buffer.from(artwork.data))
    if (image.isEmpty()) {
      deps.log.debug('artwork could not be decoded', { filePath, mime: artwork.mime })
      return null
    }

    return storeImage(image, artwork.mime, filePath)
  }

  /** Shared by embedded art and remote thumbnails: both end up a cached JPEG/PNG. */
  const storeImage = async (image: NativeImage, mime: string, source: string): Promise<string | null> => {
    const encoded = encodeArtwork(image, mime)
    const key = artworkKeyFor(encoded.data, encoded.extension)
    const target = join(cacheDir, key)
    if (!existsSync(target)) {
      await writeFile(target, encoded.data)
      deps.log.debug('cached artwork', { key, bytes: encoded.data.length, source })
    }
    return key
  }

  return {
    cacheDir,

    pathFor(key) {
      const absolute = absoluteFor(key)
      return absolute && existsSync(absolute) ? absolute : null
    },

    async cacheRemote(data, mime) {
      if (data.length === 0) return null
      const image = nativeImage.createFromBuffer(data)
      if (image.isEmpty()) {
        deps.log.debug('remote artwork could not be decoded', { mime, bytes: data.length })
        return null
      }
      return storeImage(image, mime, 'remote')
    },

    async resolve(trackId) {
      const state = deps.repo.artworkState(trackId)
      if (!state) return null
      // Already answered, negatively or positively.
      if (state.artworkKey === '') return null
      if (cached(state.artworkKey)) return state.artworkKey

      if (!state.filePath) {
        deps.repo.setArtworkKey(trackId, '')
        return null
      }

      // Every track on an album carries the same cover, so one extraction can
      // answer for all of them. Only meaningful when the album is actually known:
      // "no album" is shared by thousands of unrelated files.
      if (state.album) {
        const known = deps.repo.artworkKeyForAlbum(state.album, state.albumArtist)
        if (cached(known) && known) {
          deps.repo.setArtworkKey(trackId, known)
          return known
        }
      }

      const shared = state.album ? `${state.albumArtist ?? ''}\u0000${state.album}` : `track:${trackId}`
      const pending = inFlight.get(shared)
      if (pending) {
        const key = await pending
        deps.repo.setArtworkKey(trackId, key ?? '')
        return key
      }

      const work = store(state.filePath).catch((error: unknown) => {
        deps.log.warn('artwork extraction failed', { trackId, error })
        return null
      })
      inFlight.set(shared, work)
      try {
        const key = await work
        deps.repo.setArtworkKey(trackId, key ?? '')
        return key
      } finally {
        inFlight.delete(shared)
      }
    }
  }
}

/** Shrinks to fit the display budget, keeping the aspect ratio. */
function fit(image: NativeImage): NativeImage {
  const { width, height } = image.getSize()
  if (width <= MAX_ARTWORK_PX && height <= MAX_ARTWORK_PX) return image
  return width >= height
    ? image.resize({ width: MAX_ARTWORK_PX, quality: 'good' })
    : image.resize({ height: MAX_ARTWORK_PX, quality: 'good' })
}

/**
 * Encodes a cover for the cache.
 *
 * PNG in, PNG out: those covers can carry transparency, which a JPEG would turn
 * black. Everything else becomes a JPEG, which is several times smaller for the
 * photographic artwork that the overwhelming majority of albums use.
 */
function encodeArtwork(image: NativeImage, sourceMime: string): { data: Buffer; extension: string } {
  const fitted = fit(image)
  if (sourceMime.trim().toLowerCase() === 'image/png') {
    return { data: fitted.toPNG(), extension: '.png' }
  }
  return { data: fitted.toJPEG(88), extension: '.jpg' }
}
