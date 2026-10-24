import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(message: string, details?: unknown): void
  info(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
  error(message: string, details?: unknown): void
  /** Returns a logger whose lines are prefixed with `scope`. */
  child(scope: string): Logger
}

export interface LoggerOptions {
  /** Absolute path to the log file. Omit to log to stdout only. */
  file?: string
  level?: LogLevel
  /** Mirror to stdout. Defaults to true outside of packaged builds. */
  console?: boolean
  /** Rotate the file once it passes this size. */
  maxBytes?: number
}

/** Enough nesting to reach `fetch` -> cause -> AggregateError, but never a runaway. */
const MAX_DETAIL_DEPTH = 5
const MAX_DETAIL_ITEMS = 20

/**
 * Turns a value into something `JSON.stringify` can show without losing errors.
 *
 * An `Error`'s `name`, `message`, `stack` and `cause` are not enumerable, so a
 * plain `JSON.stringify({ error })` prints `{"error":{}}`. That is exactly how a
 * `fetch` failure used to reach the log, hiding whether the socket was reset, the
 * name lookup failed or the request timed out. Expanding errors by hand keeps the
 * useful half of a failure visible.
 */
function expandDetails(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') return `${value.toString()}n`
  if (typeof value !== 'object') return value
  if (depth >= MAX_DETAIL_DEPTH) return '[depth limit]'

  if (value instanceof Error) {
    if (seen.has(value)) return '[circular]'
    seen.add(value)

    const shape: Record<string, unknown> = { name: value.name, message: value.message }
    for (const key of ['code', 'errno', 'syscall', 'hostname', 'address', 'port'] as const) {
      const extra = (value as unknown as Record<string, unknown>)[key]
      if (extra !== undefined) shape[key] = expandDetails(extra, seen, depth + 1)
    }
    const cause = (value as { cause?: unknown }).cause
    if (cause !== undefined) shape.cause = expandDetails(cause, seen, depth + 1)
    // `AggregateError` (the shape a failed DNS lookup takes) keeps these aside.
    const nested = (value as { errors?: unknown }).errors
    if (Array.isArray(nested)) {
      shape.errors = nested.slice(0, MAX_DETAIL_ITEMS).map((item) => expandDetails(item, seen, depth + 1))
    }
    if (value.stack) shape.stack = value.stack
    return shape
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    const items = value.slice(0, MAX_DETAIL_ITEMS).map((item) => expandDetails(item, seen, depth + 1))
    if (value.length > MAX_DETAIL_ITEMS) items.push(`… ${value.length - MAX_DETAIL_ITEMS} more`)
    return items
  }

  if (seen.has(value)) return '[circular]'
  seen.add(value)
  const shape: Record<string, unknown> = {}
  let count = 0
  for (const [key, item] of Object.entries(value)) {
    if (count >= MAX_DETAIL_ITEMS) {
      shape['…'] = 'more keys omitted'
      break
    }
    shape[key] = expandDetails(item, seen, depth + 1)
    count += 1
  }
  return shape
}

/** The text a log line appends for its details. Exported so tests can pin it. */
export function serializeDetails(details: unknown): string {
  if (details === undefined) return ''
  try {
    return ` ${JSON.stringify(expandDetails(details, new WeakSet<object>(), 0))}`
  } catch {
    return ' [unserializable details]'
  }
}

class FileLogger implements Logger {
  private readonly file: string | undefined
  private readonly minLevel: number
  private readonly toConsole: boolean
  private readonly maxBytes: number
  private rotateChecked = false

  constructor(
    private readonly scope: string,
    options: LoggerOptions
  ) {
    this.file = options.file
    this.minLevel = LEVEL_ORDER[options.level ?? 'info']
    this.toConsole = options.console ?? true
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true })
      } catch {
        this.file = undefined
      }
    }
  }

  private write(level: LogLevel, message: string, details?: unknown): void {
    if (LEVEL_ORDER[level] < this.minLevel) return
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}${serializeDetails(details)}`
    if (this.toConsole) {
      const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      sink(line)
    }
    if (!this.file) return
    try {
      this.maybeRotate()
      appendFileSync(this.file, `${line}\n`, 'utf8')
    } catch {
      // Never let logging break the app.
    }
  }

  /** Rotates once per process at most once past the threshold, keeping one previous file. */
  private maybeRotate(): void {
    if (this.rotateChecked || !this.file) return
    this.rotateChecked = true
    try {
      if (statSync(this.file).size > this.maxBytes) {
        renameSync(this.file, `${this.file}.1`)
      }
    } catch {
      // Missing file on first run is expected.
    }
  }

  debug(message: string, details?: unknown): void {
    this.write('debug', message, details)
  }

  info(message: string, details?: unknown): void {
    this.write('info', message, details)
  }

  warn(message: string, details?: unknown): void {
    this.write('warn', message, details)
  }

  error(message: string, details?: unknown): void {
    this.write('error', message, details)
  }

  child(scope: string): Logger {
    return new FileLogger(`${this.scope}:${scope}`, {
      file: this.file,
      level: 'debug',
      console: this.toConsole,
      maxBytes: this.maxBytes
    })
  }
}

export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
  return new FileLogger(scope, options)
}

/** A logger that swallows everything. Handy in tests. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger
}
