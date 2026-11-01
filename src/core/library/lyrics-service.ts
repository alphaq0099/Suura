import { basename, extname } from 'node:path'
import type {
  LyricsCandidate,
  LyricsLookupQuery,
  LyricsLookupResult,
  LyricsTarget,
  StreamLyricsTarget,
  Track,
  TrackLyrics
} from '@shared/types'
import type { Logger } from '../logging/logger'
import { embeddedLyricsOf, sidecarLyricsOf, type FoundLyrics } from './lyrics'
import type { LyricsLookup } from './lyrics-lookup'
import type {
  LyricsRepository,
  StoredLyrics,
  StoredLyricsSource,
  StreamLyricsRepository,
  StoredStreamLyrics
} from './lyrics-repository'
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
 *
 * A streaming track is served by the same methods but a different store. It
 * has no file, so there is nothing to read the words from and nothing to write
 * them into; what it can do is be looked up and be shown a chosen match, held
 * against the video id so the copy follows the song rather than the queue row
 * that happened to carry it. Every method takes a target that is either a
 * library track id or that video identity, and picks its store from it.
 */
export class LyricsService {
  constructor(
    private readonly repo: TrackRepository,
    private readonly store: LyricsRepository,
    private readonly log: Logger,
    private readonly tagWriter: TagWriter | null = null,
    private readonly lookup: LyricsLookup | null = null,
    private readonly streamStore: StreamLyricsRepository | null = null
  ) {}

  /** The lyrics to show for a track, or null when it has none. */
  async read(target: LyricsTarget): Promise<TrackLyrics | null> {
    if (isStreamTarget(target)) return this.readStream(target)

    const trackId = target
    const track = await this.refreshLocal(trackId)
    if (!track) return null

    // The fetched row, when there is one, is not refreshed by the lines above:
    // it is the user's choice, and a changed file must not silently replace it.
    const stored = this.store.preferred(trackId)
    if (!stored) return null
    const lyrics = this.toTrackLyrics(track, foundOf(stored), stored)
    this.log.debug('lyrics read', { trackId, source: lyrics.source, synced: lyrics.synced })
    return lyrics
  }

  /**
   * The file's own lyrics, ignoring a fetched copy.
   *
   * The tag editor is about what is in the file: seeding its draft from a
   * provider's words would make an ordinary save write them into the tag, which
   * is the finder's explicit "Write into file" step, not an edit's side effect.
   */
  async readFile(target: LyricsTarget): Promise<TrackLyrics | null> {
    // A stream has no file, so it has no lyrics of its own to report. The tag
    // editor is the only caller and never opens on one.
    if (isStreamTarget(target)) return null

    const trackId = target
    const track = await this.refreshLocal(trackId)
    if (!track) return null
    const stored = this.store.get(trackId, 'sidecar') ?? this.store.get(trackId, 'embedded')
    if (!stored) return null
    return this.toTrackLyrics(track, foundOf(stored), stored)
  }

  /** Asks the providers for lyrics that match this row. Nothing is stored. */
  async find(target: LyricsTarget): Promise<LyricsLookupResult> {
    if (!this.lookup) throw new Error('Lyrics lookup is not available in this build.')
    return this.lookup.lookup(this.lookupQuery(target))
  }

  /** Remembers the match the user chose, then shows it. */
  async use(target: LyricsTarget, candidate: LyricsCandidate): Promise<TrackLyrics | null> {
    const input = {
      language: null,
      synced: candidate.synced,
      text: candidate.text,
      origin: candidate.url
    }

    if (isStreamTarget(target)) {
      const streams = this.streamStore
      if (!streams) throw new Error('Streaming lyrics are not available in this build.')
      streams.saveFetched(target.videoId, candidate.provider, input)
      this.log.debug('stream lyrics chosen', {
        videoId: target.videoId,
        provider: candidate.provider,
        providerId: candidate.providerId,
        synced: candidate.synced
      })
      return this.read(target)
    }

    const trackId = target
    this.localTrack(trackId)
    this.store.saveFetched(trackId, candidate.provider, input)
    this.log.debug('lyrics chosen', {
      trackId,
      provider: candidate.provider,
      providerId: candidate.providerId,
      synced: candidate.synced
    })
    return this.read(trackId)
  }

  /**
   * Forgets the fetched copy and shows what the file itself has.
   *
   * Forgetting is the point, not a side effect: the panel shows one source at
   * a time and labels it, so a hidden fetched row that could resurface would
   * make that label a guess. The button that leads here is only offered as a
   * switch-back while the file has something of its own to switch to; with no
   * file lyrics it reads as the discard it is. Getting the words back is one
   * press of the finder.
   */
  async useFile(target: LyricsTarget): Promise<TrackLyrics | null> {
    if (isStreamTarget(target)) {
      const streams = this.streamStore
      if (!streams) throw new Error('Streaming lyrics are not available in this build.')
      // A stream has no file behind the fetch, so there is nothing to switch
      // back to and nothing left to show once it is dropped.
      streams.clearFetched(target.videoId)
      this.log.debug('stream lyrics forgotten', { videoId: target.videoId })
      return null
    }

    const trackId = target
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
  async writeToFile(target: LyricsTarget): Promise<TrackLyrics | null> {
    const { filePath, trackId } = this.localTrack(target)
    if (!this.tagWriter) throw new Error('Tag editing is not available in this build.')

    const fetched = this.store.fetched(trackId)
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
   *
   * For a stream the correction is held against the video, so it survives the
   * song turning up somewhere else in the player.
   */
  setOffset(target: LyricsTarget, offsetMs: number): TrackLyrics | null {
    if (isStreamTarget(target)) {
      const streams = this.streamStore
      if (!streams) return null
      const stored = streams.preferred(target.videoId)
      if (!stored) return null
      streams.setOffset(target.videoId, stored.source, offsetMs)
      this.log.debug('stream lyrics offset set', {
        videoId: target.videoId,
        source: stored.source,
        offsetMs
      })
      return toStreamLyrics(target, stored, offsetMs)
    }

    const trackId = target
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
   *
   * A number that names no file at all — a streaming track's negative id —
   * reaches the same sentence, because that is what it means: the action is
   * about files, and this is not one.
   */
  private localTrack(target: LyricsTarget): {
    track: Track
    filePath: string
    trackId: number
  } {
    if (isStreamTarget(target)) {
      throw new Error('Only files in your library can have lyrics looked up or written.')
    }
    const trackId = target
    const track = this.repo.getById(trackId)
    if (!track || track.sourceKind !== 'local' || !track.filePath) {
      throw new Error('Only files in your library can have lyrics looked up or written.')
    }
    return { track, filePath: track.filePath, trackId }
  }

  /** A stream's stored row, or null when nothing was fetched for its video. */
  private readStream(target: StreamLyricsTarget): TrackLyrics | null {
    const stored = this.streamStore?.preferred(target.videoId)
    if (!stored) return null
    return toStreamLyrics(target, stored, stored.offsetMs)
  }

  /**
   * What the providers are asked with.
   *
   * A library row carries its own metadata; a streaming track has no row, so
   * the panel sends the values it is displaying. Both arrive as the same four
   * fields, which is the whole of the query the finder needs.
   */
  private lookupQuery(target: LyricsTarget): LyricsLookupQuery {
    if (isStreamTarget(target)) {
      return {
        title: target.title ?? '',
        artist: target.artist,
        album: target.album,
        durationMs: target.durationMs
      }
    }
    const { track } = this.localTrack(target)
    return {
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationMs: track.durationMs
    }
  }

  private async refreshLocal(trackId: number): Promise<Track | null> {
    const track = this.repo.getById(trackId)
    if (!track || track.sourceKind !== 'local' || !track.filePath) return null
    const embedded = await this.readEmbedded(track.filePath)
    const sidecar = await sidecarLyricsOf(track.filePath)
    this.store.replaceLocal(trackId, { embedded, sidecar })
    return track
  }

  private toTrackLyrics(track: Track, found: LyricsRecord, stored: StoredLyrics | null): TrackLyrics {
    return {
      trackId: track.id,
      videoId: null,
      source: found.source,
      language: found.language,
      synced: found.synced,
      text: found.text,
      offsetMs: stored?.offsetMs ?? 0,
      origin:
        found.source === 'sidecar' && track.filePath
          ? sidecarNameOf(track.filePath)
          : (stored?.origin ?? null),
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

/**
 * True when a request is about a streaming link rather than a library row.
 *
 * The two are deliberately different shapes rather than a negative number: a
 * stream cannot be resolved from its id, and the artwork request already works
 * the same way.
 */
function isStreamTarget(target: LyricsTarget): target is StreamLyricsTarget {
  return typeof target === 'object' && target !== null && target.sourceKind === 'youtube'
}

/** A stored stream row as the panel's own shape. */
function toStreamLyrics(
  target: StreamLyricsTarget,
  stored: StoredStreamLyrics,
  offsetMs: number
): TrackLyrics {
  return {
    trackId: null,
    videoId: target.videoId,
    source: stored.source,
    language: stored.language,
    synced: stored.synced,
    text: stored.text,
    offsetMs,
    origin: stored.origin,
    fetchedAt: stored.fetchedAt
  }
}

/** The sidecar's file name, for the panel's source label. */
export function sidecarNameOf(filePath: string): string {
  return `${basename(filePath, extname(filePath))}.lrc`
}
