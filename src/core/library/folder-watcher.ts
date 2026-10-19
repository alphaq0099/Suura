import { watch, type FSWatcher } from 'node:fs'
import { isAudioFile } from '@shared/mime'
import type { Logger } from '../logging/logger'

export interface FolderWatchEvent {
  /** Folders that saw activity, for the log line. */
  folders: string[]
  /** How many filesystem events were coalesced into this one change. */
  events: number
}

export interface FolderWatcherOptions {
  log: Logger
  /** Called once the folders have gone quiet. Never called while stopped. */
  onChange: (event: FolderWatchEvent) => void
  /** How long the folders have to be quiet before a change is worth reacting to. */
  quietMs?: number
  /** Longest a change may be held back while events keep arriving. */
  maxDelayMs?: number
}

/** Quiet period after the last event. A copy or a tag edit lands in one batch. */
const DEFAULT_QUIET_MS = 800
/**
 * A large copy emits events continuously, so waiting for quiet on its own would
 * postpone the scan until the copy ends. This is the point at which a scan is
 * worth starting anyway; the copy finishing produces another change shortly after.
 */
const DEFAULT_MAX_DELAY_MS = 5_000

/**
 * Whether an event is worth reacting to.
 *
 * A `change` is a file being written, so only an audio file is worth a scan for:
 * that is what filters out a written cover.jpg, a playlist file, and the `.part`
 * files a download leaves behind. A `rename` is a create, a move or a delete, and
 * the name cannot be trusted to tell a file from a folder (a folder called
 * "Album.2024" reads as a file), so everything is accepted — a folder leaving
 * with its tracks in it is exactly the change that must not be missed.
 */
export function isLibraryEvent(eventType: string, filename: string | null): boolean {
  if (eventType !== 'change') return true
  if (!filename) return true
  return isAudioFile(filename)
}

/**
 * Watches the library folders and reports that something changed.
 *
 * It deliberately does not know what to do about a change: the caller decides
 * whether that means a scan, and the scan itself already knows how to skip files
 * whose size and mtime are unchanged. That is what makes it affordable to react
 * to a change with a whole-library scan rather than trying to track individual
 * files here.
 *
 * `recursive` is one OS handle for a whole tree — Windows has supported it since
 * forever, and Node does it on Linux and macOS too — so a library of any depth
 * costs one watcher per configured folder.
 */
export class FolderWatcher {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly quietMs: number
  private readonly maxDelayMs: number
  private pending = new Set<string>()
  private pendingEvents = 0
  private quietTimer: NodeJS.Timeout | null = null
  private maxDelayTimer: NodeJS.Timeout | null = null
  private stopped = true

  constructor(private readonly options: FolderWatcherOptions) {
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  }

  /** Folders currently being watched, in the order they were added. */
  folders(): string[] {
    return [...this.watchers.keys()]
  }

  isWatching(): boolean {
    return this.watchers.size > 0
  }

  /**
   * Watches exactly this set of folders, adding and dropping watchers as the set
   * changes, so a settings edit does not disturb the folders that stayed.
   *
   * A folder that cannot be watched — deleted, on a disconnected drive, or
   * permission denied — is logged and skipped rather than throwing: the library
   * still works, it just does not notice changes there until something re-watches.
   */
  setFolders(folders: string[]): void {
    const wanted = new Set(folders)
    for (const [folder, watcher] of this.watchers) {
      if (wanted.has(folder)) continue
      this.close(watcher, folder)
      this.watchers.delete(folder)
    }
    for (const folder of wanted) {
      if (this.watchers.has(folder)) continue
      this.open(folder)
    }
    if (this.watchers.size === 0) this.clearTimers()
    this.stopped = false
  }

  /** Stops watching and forgets any change that has not been reported yet. */
  stop(): void {
    this.stopped = true
    for (const [folder, watcher] of this.watchers) this.close(watcher, folder)
    this.watchers.clear()
    this.clearTimers()
  }

  private open(folder: string): void {
    try {
      const watcher = watch(folder, { recursive: true }, (eventType, filename) => {
        this.handleEvent(folder, eventType, filename)
      })
      watcher.on('error', (error) => {
        this.options.log.warn('folder watcher failed', { folder, error })
        const current = this.watchers.get(folder)
        if (current) {
          this.close(current, folder)
          this.watchers.delete(folder)
        }
      })
      this.watchers.set(folder, watcher)
      this.options.log.debug('watching folder', { folder })
    } catch (error) {
      this.options.log.warn('could not watch folder', { folder, error })
    }
  }

  private close(watcher: FSWatcher, folder: string): void {
    try {
      watcher.close()
      this.options.log.debug('stopped watching folder', { folder })
    } catch (error) {
      this.options.log.warn('could not close folder watcher', { folder, error })
    }
  }

  private handleEvent(folder: string, eventType: string, filename: string | null): void {
    if (this.stopped) return
    if (!isLibraryEvent(eventType, filename)) return
    this.pending.add(folder)
    this.pendingEvents += 1
    this.schedule()
  }

  private schedule(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer)
    this.quietTimer = setTimeout(() => this.report(), this.quietMs)
    this.quietTimer.unref()
    if (!this.maxDelayTimer) {
      this.maxDelayTimer = setTimeout(() => this.report(), this.maxDelayMs)
      this.maxDelayTimer.unref()
    }
  }

  private report(): void {
    if (this.stopped) return
    const folders = [...this.pending]
    const events = this.pendingEvents
    this.pending = new Set()
    this.pendingEvents = 0
    this.clearTimers()
    if (folders.length === 0) return
    this.options.onChange({ folders, events })
  }

  private clearTimers(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer)
    if (this.maxDelayTimer) clearTimeout(this.maxDelayTimer)
    this.quietTimer = null
    this.maxDelayTimer = null
  }
}
