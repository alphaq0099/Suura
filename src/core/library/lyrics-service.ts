import { basename, extname } from 'node:path'
import type { Track, TrackLyrics } from '@shared/types'
import type { Logger } from '../logging/logger'
import { embeddedLyricsOf, sidecarLyricsOf, type FoundLyrics } from './lyrics'
import type { LyricsRepository, StoredLyrics } from './lyrics-repository'
import { loadMetadataParser } from './metadata'
import type { TrackRepository } from './track-repository'

/**
 * Lyrics that are already on disk, read on demand.
 *
 * Nothing here talks to the network: a file's own tag and a `.lrc` beside it are
 * the whole answer. The database keeps the timing correction and a copy of what
 * was found, so a later phase can add fetched lyrics next to them.
 *
 * The local sources are re-read on every call rather than served from the cache.
 * A tag edit or a sidecar dropped next to the file must be visible immediately,
 * and parsing one local file is cheaper than deciding whether a cache is stale.
 */
export class LyricsService {
  constructor(
    private readonly repo: TrackRepository,
    private readonly store: LyricsRepository,
    private readonly log: Logger
  ) {}

  /** The lyrics to show for a track, or null when it has none. */
  async read(trackId: number): Promise<TrackLyrics | null> {
    const track = this.repo.getById(trackId)
    if (!track || track.sourceKind !== 'local' || !track.filePath) return null

    const embedded = await this.readEmbedded(track.filePath)
    const sidecar = await sidecarLyricsOf(track.filePath)
    this.store.replaceLocal(trackId, { embedded, sidecar })

    const chosen = sidecar ?? embedded
    if (!chosen) return null
    const stored = this.store.get(trackId, chosen.source)
    const lyrics = this.toTrackLyrics(track, chosen, stored)
    this.log.debug('lyrics read', { trackId, source: lyrics.source, synced: lyrics.synced })
    return lyrics
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

  private toTrackLyrics(track: Track, found: FoundLyrics, stored: StoredLyrics | null): TrackLyrics {
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
function foundOf(stored: StoredLyrics): FoundLyrics {
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
