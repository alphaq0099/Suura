import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { mimeForExtension } from '@core/library/artwork'
import type { TagLookup } from '@core/library/tag-lookup'
import type { TrackRepository } from '@core/library/track-repository'
import type { Logger } from '@core/logging/logger'
import type { ArtworkChoice, TagCandidate, TagProvider, Track } from '@shared/types'
import { isYouTubeVideoId, youtubeThumbnailCandidates } from '@shared/youtube'
import type { ArtworkService } from './artwork-service'

/**
 * The covers the artwork picker can offer.
 *
 * Everything is answered with an artwork-cache key, never a URL or a path: the
 * picker shows the key through `player-art://`, and Save sends the same key
 * back, so the bytes written into the file are the ones the user saw. Nothing
 * here writes a tag; the picker only proposes.
 *
 * `local` is the cheap answer: what is already on this machine, plus the video
 * still the file came from. `online` asks the tag providers and is only called
 * when the user presses the button, because it costs two network requests.
 */

/** Covers next to the file, in the order a person would expect them. */
const FOLDER_COVER_BASES = ['cover', 'folder', 'front', 'album', 'albumart'] as const
const FOLDER_COVER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'] as const

/** A provider cover is fetched from a public CDN: cap it like a thumbnail. */
const COVER_TIMEOUT_MS = 5_000
const MAX_COVER_BYTES = 8 * 1024 * 1024

const PROVIDER_LABEL: Record<TagProvider, string> = {
  itunes: 'iTunes',
  musicbrainz: 'MusicBrainz',
  // The acoustid candidate's cover is the Cover Art Archive's front image.
  acoustid: 'Cover Art Archive'
}

export interface ArtworkChoicesService {
  /** Embedded art, a folder cover and the source video's still, best first. */
  local(trackId: number): Promise<ArtworkChoice[]>
  /** Covers from the tag providers. Network, and only when asked. */
  online(trackId: number): Promise<ArtworkChoice[]>
}

export interface ArtworkChoicesOptions {
  repo: TrackRepository
  artwork: ArtworkService
  tagLookup: TagLookup
  log: Logger
  /** Injected by the self-test so the picker can be driven offline. */
  fetch?: typeof fetch
}

export function createArtworkChoices(options: ArtworkChoicesOptions): ArtworkChoicesService {
  const request = options.fetch ?? fetch

  const load = (trackId: number): Track => {
    const track = options.repo.getById(trackId)
    if (!track) throw new Error('That track is no longer in the library.')
    if (track.sourceKind !== 'local' || !track.filePath) {
      throw new Error('Only files in your library can have their cover changed.')
    }
    return track
  }

  /** Fetches one image and caches it; null on any failure, so callers move on. */
  const fetchImage = async (url: string): Promise<string | null> => {
    try {
      const response = await request(url, { signal: AbortSignal.timeout(COVER_TIMEOUT_MS) })
      if (!response.ok) return null

      const mime = response.headers.get('content-type') ?? ''
      if (!mime.startsWith('image/')) return null

      const declared = Number(response.headers.get('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > MAX_COVER_BYTES) return null

      const data = Buffer.from(await response.arrayBuffer())
      if (data.length === 0 || data.length > MAX_COVER_BYTES) return null

      // `cacheRemote` returns null when the bytes do not decode.
      return await options.artwork.cacheRemote(data, mime)
    } catch (error) {
      options.log.debug('cover could not be fetched', { url, error })
      return null
    }
  }

  const collect = (current: string | null) => {
    const choices: ArtworkChoice[] = []
    return {
      choices,
      push(key: string | null, kind: ArtworkChoice['kind'], label: string): void {
        if (!key) return
        if (choices.some((choice) => choice.key === key)) return
        choices.push({ key, kind, label, current: key === current })
      }
    }
  }

  return {
    async local(trackId) {
      const track = load(trackId)
      // `resolve` also records the answer on the row, so it is the cheapest way
      // to learn both the key and whether there is one at all.
      const current = await options.artwork.resolve(trackId)
      const { choices, push } = collect(current)

      push(current, 'embedded', 'In the file')

      const folder = await findFolderCover(track.filePath as string)
      if (folder) {
        const data = await readFile(folder).catch(() => null)
        if (data) {
          const key = await options.artwork.cacheRemote(data, mimeForExtension(extname(folder)))
          push(key, 'folder', basename(folder))
        }
      }

      // A downloaded track knows the video it came from, so its still is one
      // more cover without asking any metadata service.
      const videoId = track.originKind === 'youtube' ? track.originId : null
      if (videoId && isYouTubeVideoId(videoId)) {
        for (const url of youtubeThumbnailCandidates(videoId)) {
          const key = await fetchImage(url)
          if (key) {
            push(key, 'video', 'Video thumbnail')
            break
          }
        }
      }

      return choices
    },

    async online(trackId) {
      const track = load(trackId)
      const { choices, push } = collect(track.artworkKey)

      const result = await options.tagLookup.lookup({
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationMs: track.durationMs
      })

      const seen = new Set<string>()
      const pushCandidateCovers = async (candidates: TagCandidate[]): Promise<void> => {
        for (const candidate of candidates) {
          const url = candidate.artworkUrl
          if (!url || seen.has(url)) continue
          seen.add(url)
          const key = await fetchImage(url)
          push(key, 'provider', PROVIDER_LABEL[candidate.provider])
          // A handful is a choice; a hundred is a second search.
          if (choices.length >= 6) break
        }
      }

      await pushCandidateCovers(result.candidates)

      // A file with unusable tags can still have a findable cover: the audio
      // itself names the release. Only spend an fpcalc run when the text search
      // found nothing to show.
      if (choices.length === 0 && track.filePath) {
        const fingerprint = await options.tagLookup.lookupFingerprint(
          {
            title: track.title,
            artist: track.artist,
            album: track.album,
            durationMs: track.durationMs
          },
          track.filePath
        )
        await pushCandidateCovers(fingerprint.candidates)
      }

      return choices
    }
  }
}

/**
 * The first folder cover, matched without regard to case.
 *
 * Windows users get `Cover.JPG` from plenty of rippers, and a case-sensitive
 * comparison would silently find nothing on the platform this app runs on most.
 */
export async function findFolderCover(filePath: string): Promise<string | null> {
  const folder = dirname(filePath)
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => null)
  if (!entries) return null

  const byLower = new Map<string, string>()
  for (const entry of entries) {
    if (entry.isFile()) byLower.set(entry.name.toLowerCase(), entry.name)
  }

  for (const base of FOLDER_COVER_BASES) {
    for (const extension of FOLDER_COVER_EXTENSIONS) {
      const found = byLower.get(`${base}${extension}`)
      if (found) return join(folder, found)
    }
  }
  return null
}
