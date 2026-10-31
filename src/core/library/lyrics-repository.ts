import type { LyricsSource } from '@shared/types'
import type { SqlDatabase } from '../db/driver'

/** The two sources that live on disk. */
export type LocalLyricsSource = Extract<LyricsSource, 'embedded' | 'sidecar'>

/** Everything the table can hold today: the file's own lyrics, plus a fetch. */
export type StoredLyricsSource = LocalLyricsSource | 'lrclib'

export interface StoredLyrics {
  trackId: number
  source: StoredLyricsSource
  language: string | null
  synced: boolean
  text: string
  offsetMs: number
  fetchedAt: number
}

interface LyricsRow {
  track_id: number
  source: string
  language: string | null
  synced: number
  text: string
  offset_ms: number
  fetched_at: number
}

const COLUMNS = `track_id, source, language, synced, text, offset_ms, fetched_at`

function toSource(value: string): StoredLyricsSource {
  if (value === 'sidecar') return 'sidecar'
  if (value === 'lrclib') return 'lrclib'
  return 'embedded'
}

function mapRow(row: LyricsRow): StoredLyrics {
  return {
    trackId: row.track_id,
    source: toSource(row.source),
    language: row.language,
    synced: row.synced === 1,
    text: row.text,
    offsetMs: row.offset_ms,
    fetchedAt: row.fetched_at
  }
}

/**
 * What the app has found for a track, keyed by source.
 *
 * The file remains the truth for `embedded` and `sidecar`, so those rows are
 * refreshed every time the lyrics are read. What the table adds is the user's
 * timing correction, which belongs to no file, and the one fetched copy the
 * user chose from the finder.
 *
 * The foreign key means deleting a track drops its lyrics with it, exactly as
 * playlist entries already behave.
 */
export class LyricsRepository {
  constructor(private readonly db: SqlDatabase) {}

  get(trackId: number, source: StoredLyricsSource): StoredLyrics | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM track_lyrics WHERE track_id = ? AND source = ?`)
      .get<LyricsRow>(trackId, source)
    return row ? mapRow(row) : null
  }

  /**
   * The source the player shows when several exist.
   *
   * A fetched lyric wins because choosing one is an explicit act: the user
   * asked for that match, and it must not be hidden by a sidecar that was
   * already there. Without one, a `.lrc` wins over an embedded tag: it is the
   * copy a user can edit without rewriting the audio, and it is what a lyric
   * downloader writes. The order is one list so a later source only has to be
   * inserted in the right place.
   */
  preferred(trackId: number): StoredLyrics | null {
    const order: StoredLyricsSource[] = ['lrclib', 'sidecar', 'embedded']
    for (const source of order) {
      const row = this.get(trackId, source)
      if (row) return row
    }
    return null
  }

  /**
   * Records what a read found. A source that is no longer there is removed, so
   * a deleted tag or sidecar does not keep answering for the track. The offset
   * is deliberately not in the update list: it is the user's, not the file's.
   */
  replaceLocal(
    trackId: number,
    found: { embedded: StoredLyricsInput | null; sidecar: StoredLyricsInput | null },
    now = Date.now()
  ): void {
    this.db.transaction(() => {
      this.write(trackId, 'embedded', found.embedded, now)
      this.write(trackId, 'sidecar', found.sidecar, now)
    })
  }

  setOffset(trackId: number, source: StoredLyricsSource, offsetMs: number): void {
    this.db
      .prepare(`UPDATE track_lyrics SET offset_ms = ? WHERE track_id = ? AND source = ?`)
      .run(offsetMs, trackId, source)
  }

  /**
   * Remembers the lyrics the user chose from the finder.
   *
   * This is the one row the file does not own, so it is written only when a
   * match is chosen and removed when the user goes back to the file. Its
   * offset is left alone by the upsert, exactly as a local source's is: the
   * correction belongs to the user, not to the text that arrived today.
   */
  saveFetched(trackId: number, input: StoredLyricsInput, now = Date.now()): void {
    this.write(trackId, 'lrclib', input, now)
  }

  /** Forgets the chosen fetch, so the file's own lyrics are shown again. */
  clearFetched(trackId: number): void {
    this.db.prepare(`DELETE FROM track_lyrics WHERE track_id = ? AND source = 'lrclib'`).run(trackId)
  }

  /** Test and maintenance helper: forgets every cached lyric. */
  clear(): number {
    return this.db.prepare('DELETE FROM track_lyrics').run().changes
  }

  private write(
    trackId: number,
    source: StoredLyricsSource,
    input: StoredLyricsInput | null,
    now: number
  ): void {
    if (!input) {
      this.db.prepare(`DELETE FROM track_lyrics WHERE track_id = ? AND source = ?`).run(trackId, source)
      return
    }
    this.db
      .prepare(
        `INSERT INTO track_lyrics (track_id, source, language, synced, text, offset_ms, fetched_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(track_id, source) DO UPDATE SET
           language   = excluded.language,
           synced     = excluded.synced,
           text       = excluded.text,
           fetched_at = excluded.fetched_at`
      )
      .run(trackId, source, input.language, input.synced, input.text, now)
  }
}

export interface StoredLyricsInput {
  language: string | null
  synced: boolean
  text: string
}
