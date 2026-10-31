import { basename, extname } from 'node:path'
import type { LyricsCandidate, LyricsLookupResult, Track, TrackLyrics } from '@shared/types'
import type { Logger } from '../logging/logger'
import { embeddedLyricsOf, sidecarLyricsOf, type FoundLyrics } from './lyrics'
import type { LyricsLookup } from './lyrics-lookup'
import type { LyricsRepository, StoredLyrics, StoredLyricsSource } from './lyrics-repository'
import { loadMetadataParser } from './metadata'
import type { TagWriter } from './tag-writer'
import type { TrackRepository } from './track-repository'

/** The shape both a read and a stored row share. */
interface LyricsRecord {
  text: string
  language: string | null
  synced: boolean
  source: StoredLyricsSource
}

/**
 * The lyrics a local file has, plus the one fetched copy the user chose.
 *
 * Reading is local and cheap: a tag inside the file and a `.lrc` beside it are
 * re-read on every call rather than served from a cache, so a tag edit or a
 * dropped sidecar is visible immediately. The finder is the only part that
 * talks to the network, and it only proposes; nothing is stored until the user
 * chooses a match. Writing that match into the file is a separate, explicit
 * step through the same `TagWriter` the manual editor uses.
 */
export class LyricsService {
  constructor(
    private readonly repo: TrackRepository,
    private readonly store: LyricsRepository,
    private readonly log: Logger,
    private readonly tagWriter: TagWriter | null = null,
    private readonly lookup: LyricsLookup | null = null
  ) {}

  /** The lyrics to show for a track, or null when it has none. */
  async read(trackId: number): Promise<TrackLyrics | null> {
    const track = this.repo.getById(trackId)
    if (!track || track.sourceKind !== 'local' || !track.filePath) return null

    const embedded = await this.readEmbedded(track.filePath)
    const sidecar = await sidecarLyricsOf(track.filePath)
    this.store.replaceLocal(trackId, { embedded, sidecar })

    // The fetched row, when there is one, is not refreshed by the lines above:
    // it is the user's choice, and a changed file must not silently replace it.
    const stored = this.store.preferred(trackId)
    if (!stored) return null
    const lyrics = this.toTrackLyrics(track, foundOf(stored), stored)
    this.log.debug('lyrics read', { trackId, source: lyrics.source, synced: lyrics.synced })
    return lyrics
  }

  /** Asks LRCLIB for lyrics that match this file. Nothing is stored. */
  async find(trackId: number): Promise<LyricsLookupResult> {
    const { track } = this.localTrack(trackId)
    if (!this.lookup) throw new Error('Lyrics lookup is not available in this build.')
    return this.lookup.lookup({
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationMs: track.durationMs
    })
  }

  /** Remembers the match the user chose, then shows it. */
  async use(trackId: number, candidate: LyricsCandidate): Promise<TrackLyrics | null> {
    this.localTrack(trackId)
    this.store.saveFetched(trackId, {
      language: null,
      synced: candidate.synced,
      text: candidate.text
    })
    this.log.debug('lyrics chosen', {
      trackId,
      provider: candidate.provider,
      providerId: candidate.providerId,
      synced: candidate.synced
    })
    return this.read(trackId)
  }

  /** Forgets the fetched copy and shows what the file itself has. */
  async useFile(trackId: number): Promise<TrackLyrics | null> {
    this.localTrack(trackId)
    this.store.clearFetched(trackId)
    this.log.debug('lyrics switched back to the file', { trackId })
    return this.read(trackId)
  }

  /**
   * Writes the chosen fetch into the file's own tag.
   *
   * The fetched row is removed afterwards, so the file becomes the source and
   * the panel's label changes with it. A `.lrc` beside the file is refused:
   * that copy wins over the tag, so writing would look like nothing happened.
   */
  async writeToFile(trackId: number): Promise<TrackLyrics | null> {
    const { filePath } = this.localTrack(trackId)
    if (!this.tagWriter) throw new Error('Tag editing is not available in this build.')

    const fetched = this.store.get(trackId, 'lrclib')
    if (!fetched) throw new Error('There are no fetched lyrics to write into this file.')

    const sidecar = await sidecarLyricsOf(filePath)
    if (sidecar) {
      throw new Error(
        'A .lrc file beside this track is what the player shows. Edit or remove it instead.'
      )
    }

    await this.tagWriter.write(filePath, { lyrics: fetched.text })
    this.store.clearFetched(trackId)
    this.log.debug('lyrics written into the file', { trackId })
    return this.read(trackId)
  }

  /**
   * Moves the lyrics earlier or later for this track.
   *
   * The offset belongs to the source that is currently shown, so a sidecar that
   * appears later starts at its own zero rather than inheriting a correction
   * meant for the tag. Reading first is what the UI does; an offset for lyrics
   * that were never read is refused rather than stored against nothing.
   */
  setOffset(trackId: number, offsetMs: number): TrackLyrics | null {
    const track = this.repo.getById(trackId)
    if (!track || track.sourceKind !== 'local' || !track.filePath) return null
    const stored = this.store.preferred(trackId)
    if (!stored) return null
    this.store.setOffset(trackId, stored.source, offsetMs)
    this.log.debug('lyrics offset set', { trackId, source: stored.source, offsetMs })
    return this.toTrackLyrics(track, foundOf(stored), { ...stored, offsetMs })
  }

  private async readEmbedded(filePath: string): Promise<FoundLyrics | null> {
    try {
      const parseFile = await loadMetadataParser()
      const parsed = await parseFile(filePath, { duration: false, skipCovers: true })
      return embeddedLyricsOf(parsed)
    } catch (error) {
      // A file that cannot be parsed may still have a readable sidecar, so this
      // is not an error the caller has to handle.
      this.log.debug('could not read embedded lyrics', { filePath, error })
      return null
    }
  }

  /**
   * Resolves a row that can have a file at all. Reads stay quiet for streams
   * (they simply have no lyrics); every action that would store or write
   * something is a mistake on a stream and says so.
   */
  private localTrack(trackId: number): { track: Track; filePath: string } {
    const track = this.repo.getById(trackId)
    if (!track || track.sourceKind !== 'local' || !track.filePath) {
      throw new Error('Only files in your library can have lyrics looked up or written.')
    }
    return { track, filePath: track.filePath }
  }

  private toTrackLyrics(track: Track, found: LyricsRecord, stored: StoredLyrics | null): TrackLyrics {
    return {
      trackId: track.id,
      source: found.source,
      language: found.language,
      synced: found.synced,
      text: found.text,
      offsetMs: stored?.offsetMs ?? 0,
      origin: found.source === 'sidecar' && track.filePath ? sidecarNameOf(track.filePath) : null,
      fetchedAt: stored?.fetchedAt ?? Date.now()
    }
  }
}

/** A stored row as the reader's own shape, so both paths share the mapper. */
function foundOf(stored: StoredLyrics): LyricsRecord {
  return {
    text: stored.text,
    language: stored.language,
    synced: stored.synced,
    source: stored.source
  }
}

/** The sidecar's file name, for the panel's source label. */
export function sidecarNameOf(filePath: string): string {
  return `${basename(filePath, extname(filePath))}.lrc`
}
