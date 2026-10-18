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

function serialize(details: unknown): string {
  if (details === undefined) return ''
  if (details instanceof Error) return ` ${details.name}: ${details.message}${details.stack ? `\n${details.stack}` : ''}`
  try {
    return ` ${JSON.stringify(details)}`
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
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}${serialize(details)}`
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
