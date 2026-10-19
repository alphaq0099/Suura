import type { Playlist, PlaylistDetail } from '@shared/types'
import { PlaylistRepository, POSITION_GAP, type PositionedItem } from './playlist-repository'
import type { TrackRepository } from './track-repository'
import type { Logger } from '../logging/logger'

export interface AddTracksResult {
  /** Entries actually created. */
  added: number
  /** Tracks already in the playlist, or no longer in the library. */
  skipped: number
}

/** Longest playlist name the UI can produce, enforced here as well as in the form. */
const MAX_NAME_LENGTH = 120

/**
 * Playlists: names, contents, and the order of the contents.
 *
 * Ordering lives here rather than in the repository because it is the one piece
 * of policy that is easy to get subtly wrong: a move has to land *between* two
 * neighbours, which is a decision about numbers, not a statement about rows.
 *
 * Playlists are stored locally and are not part of the renderer's state beyond
 * the view that is showing them: every mutation is answered with the new state,
 * so there is nothing to keep in sync.
 */
export class PlaylistService {
  constructor(
    private readonly repo: PlaylistRepository,
    private readonly tracks: TrackRepository,
    private readonly log: Logger
  ) {}

  list(): Playlist[] {
    return this.repo.list()
  }

  detail(id: number): PlaylistDetail | null {
    return this.repo.detail(id)
  }

  /**
   * Creates a playlist. Names are unique case-insensitively: two playlists called
   * "Chill" and "chill" are indistinguishable in the sidebar, and the unique
   * index would refuse the second one with a raw SQLite error.
   */
  create(rawName: string): Playlist {
    const name = this.cleanName(rawName)
    const clash = this.repo.idForName(name)
    if (clash !== null) {
      throw new Error(`There is already a playlist called "${name}".`)
    }
    const id = this.repo.create(name, Date.now())
    this.log.info('playlist created', { id, name })
    const created = this.repo.get(id)
    if (!created) throw new Error('The playlist could not be created.')
    return created
  }

  rename(id: number, rawName: string): Playlist {
    this.require(id)
    const name = this.cleanName(rawName)
    const clash = this.repo.idForName(name)
    if (clash !== null && clash !== id) {
      throw new Error(`There is already a playlist called "${name}".`)
    }
    this.repo.rename(id, name, Date.now())
    const renamed = this.repo.get(id)
    if (!renamed) throw new Error('The playlist no longer exists.')
    return renamed
  }

  delete(id: number): void {
    this.require(id)
    this.repo.delete(id)
    this.log.info('playlist deleted', { id })
  }

  /**
   * Adds tracks to the end of a playlist, in the order given.
   *
   * Adding something that is already there is not an error: the action reads as
   * "make sure this is in the playlist", and a second click on the same button
   * doing nothing is what a user expects. Tracks that have left the library are
   * skipped for the same reason — the selection can be stale by a scan.
   */
  addTracks(playlistId: number, trackIds: number[]): AddTracksResult {
    this.require(playlistId)
    const alreadyThere = this.repo.trackIdsIn(playlistId)
    const now = Date.now()
    let added = 0
    let skipped = 0

    this.repo.transaction(() => {
      let position = this.repo.nextPosition(playlistId)
      for (const trackId of trackIds) {
        if (alreadyThere.has(trackId) || !this.tracks.getById(trackId)) {
          skipped += 1
          continue
        }
        if (this.repo.addTrack(playlistId, trackId, position, now)) {
          added += 1
          alreadyThere.add(trackId)
          position += POSITION_GAP
        } else {
          skipped += 1
        }
      }
    })

    if (added > 0) this.log.info('tracks added to playlist', { playlistId, added, skipped })
    return { added, skipped }
  }

  /** Removes entries. Ids are entry ids, so the same track in two playlists is safe. */
  removeItems(playlistId: number, itemIds: number[]): number {
    this.require(playlistId)
    const mine = new Set(this.repo.positionedItems(playlistId).map((item) => item.id))
    const owned = itemIds.filter((itemId) => mine.has(itemId))
    const removed = this.repo.transaction(() => this.repo.removeItems(owned, Date.now()))
    if (removed > 0) this.log.info('tracks removed from playlist', { playlistId, removed })
    return removed
  }

  clear(playlistId: number): number {
    this.require(playlistId)
    const removed = this.repo.clearItems(playlistId, Date.now())
    if (removed > 0) this.log.info('playlist cleared', { playlistId, removed })
    return removed
  }

  /**
   * Moves an entry so that it ends up at `toIndex` in the final order.
   *
   * `toIndex` counts the list as it will be *after* the move, which is what a
   * drop position means on screen: dropping the first row of five onto the third
   * gap puts it at index 2, not 3.
   */
  moveItem(playlistId: number, itemId: number, toIndex: number): boolean {
    this.require(playlistId)
    const items = this.repo.positionedItems(playlistId)
    const from = items.findIndex((item) => item.id === itemId)
    if (from < 0) throw new Error('That entry is not in this playlist.')

    const without = items.filter((item) => item.id !== itemId)
    const target = Math.max(0, Math.min(Math.trunc(toIndex), without.length))
    if (target === from) return false

    const before = target > 0 ? (without[target - 1] as PositionedItem) : null
    const after = target < without.length ? (without[target] as PositionedItem) : null
    const now = Date.now()

    const moved = this.repo.transaction(() => {
      let position: number
      if (!before && !after) {
        position = POSITION_GAP
      } else if (!before) {
        position = (after as PositionedItem).position - POSITION_GAP
      } else if (!after) {
        position = before.position + POSITION_GAP
      } else if (after.position - before.position >= 2) {
        position = Math.floor((before.position + after.position) / 2)
      } else {
        // The neighbours have closed up: drops have landed here repeatedly. Spread
        // the remaining entries out again, after which the position for an index is
        // exact rather than a guess.
        this.repo.renumber(without.map((item) => item.id))
        position = target * POSITION_GAP + POSITION_GAP / 2
      }
      this.repo.setPosition(itemId, position)
      this.repo.touch(playlistId, now)
      return true
    })
    this.log.debug('playlist entry moved', { playlistId, itemId, from, toIndex: target })
    return moved
  }

  private require(id: number): Playlist {
    const playlist = this.repo.get(id)
    if (!playlist) throw new Error('That playlist no longer exists.')
    return playlist
  }

  private cleanName(rawName: string): string {
    const name = rawName.trim().replace(/\s+/g, ' ')
    if (name.length === 0) throw new Error('A playlist needs a name.')
    if (name.length > MAX_NAME_LENGTH) {
      throw new Error(`A playlist name can be at most ${MAX_NAME_LENGTH} characters.`)
    }
    return name
  }
}
