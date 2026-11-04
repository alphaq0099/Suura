import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from '@core/logging/logger'
import type { CrashReportSummary, CrashReportsStatus, CrashReportKind } from '@shared/types'

/**
 * Local crash reports.
 *
 * There is no remote crash service and no upload path in this file. A report is
 * a small JSON file under the user's app-data folder, written only when the user
 * has switched crash reports on. Settings can list, export and clear them.
 *
 * The main process writes synchronously because an uncaught exception gets one
 * chance to leave a trace before the process dies. Every failure here is
 * swallowed: a crashed app must not crash again while trying to explain itself.
 */

/** How many report files stay on disk. Older ones are dropped as new ones arrive. */
export const CRASH_REPORT_KEEP = 20
/** Bounds on free text, so one runaway error cannot produce a huge file. */
const MAX_MESSAGE = 4_000
const MAX_STACK = 20_000
const MAX_DETAIL_DEPTH = 5
const MAX_DETAIL_ITEMS = 20
const FILE_PREFIX = 'crash-'
const FILE_SUFFIX = '.json'

export interface CrashReportEnvironment {
  appVersion: string
  platform: string
  arch: string
  electron: string
  chromium: string
  node: string
}

export interface CrashReportInput {
  kind: CrashReportKind
  /** A short machine reason, such as `uncaughtException` or `crashed`. */
  reason: string
  message?: string | null
  stack?: string | null
  exitCode?: number | null
  /** Extra context, serialised defensively. */
  details?: unknown
}

export interface CrashReporterOptions {
  dir: string
  log: Logger
  /** The user's opt-in switch, read live so Settings needs no restart. */
  enabled: () => boolean
  environment: () => CrashReportEnvironment
  /** Injectable clock for tests. */
  now?: () => Date
  keep?: number
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function text(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\r\n?/g, '\n').replace(/\0/g, '').trim()
  return trimmed.length > 0 ? trimmed.slice(0, limit) : null
}

/** Turns arbitrary details into JSON-safe data without throwing on cycles. */
function safeDetails(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') return `${value.toString()}n`
  if (typeof value !== 'object') return value
  if (depth >= MAX_DETAIL_DEPTH) return '[depth limit]'

  if (value instanceof Error) {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ? value.stack.slice(0, MAX_STACK) : null,
      cause: value.cause === undefined ? null : safeDetails(value.cause, seen, depth + 1)
    }
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    const items = value.slice(0, MAX_DETAIL_ITEMS).map((item) => safeDetails(item, seen, depth + 1))
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
    shape[key] = safeDetails(item, seen, depth + 1)
    count += 1
  }
  return shape
}

function reportName(occurredAt: Date, kind: CrashReportKind): string {
  const stamp = occurredAt.toISOString().replace(/[:.]/g, '-')
  return `${FILE_PREFIX}${stamp}-${kind}${FILE_SUFFIX}`
}

function isReportFile(name: string): boolean {
  return name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX)
}

interface StoredReport {
  format: 1
  id: string
  occurredAt: string
  kind: CrashReportKind
  reason: string
  message: string | null
  stack: string | null
  exitCode: number | null
  details: unknown
  environment: CrashReportEnvironment
  process: { pid: number; uptimeSeconds: number }
}

/** Reads one report's header, tolerating a file that was cut off mid-write. */
function readSummary(filePath: string, name: string): CrashReportSummary | null {
  try {
    const bytes = statSync(filePath).size
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<StoredReport>
    const occurredAt = Date.parse(typeof parsed.occurredAt === 'string' ? parsed.occurredAt : '')
    return {
      id: typeof parsed.id === 'string' ? parsed.id : name,
      kind:
        parsed.kind === 'main-exception' ||
        parsed.kind === 'main-rejection' ||
        parsed.kind === 'renderer' ||
        parsed.kind === 'child-process'
          ? parsed.kind
          : 'unknown',
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'unknown',
      message: typeof parsed.message === 'string' ? parsed.message : null,
      occurredAt: Number.isFinite(occurredAt) ? occurredAt : 0,
      bytes
    }
  } catch {
    // A malformed report is still evidence that something happened. Keep it in
    // the count so Settings does not claim the folder is empty.
    try {
      return {
        id: name,
        kind: 'unknown',
        reason: 'unreadable report',
        message: null,
        occurredAt: statSync(filePath).mtimeMs,
        bytes: statSync(filePath).size
      }
    } catch {
      return null
    }
  }
}

/** Every readable report, newest first. Never throws. */
export function listCrashReports(dir: string): CrashReportSummary[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter(isReportFile)
  } catch {
    return []
  }
  const summaries: CrashReportSummary[] = []
  for (const name of names) {
    const summary = readSummary(join(dir, name), name)
    if (summary) summaries.push(summary)
  }
  return summaries.sort((a, b) => b.occurredAt - a.occurredAt)
}

/** Deletes every report file. Returns how many were removed. */
export function clearCrashReports(dir: string): number {
  let removed = 0
  let names: string[]
  try {
    names = readdirSync(dir).filter(isReportFile)
  } catch {
    return 0
  }
  for (const name of names) {
    try {
      rmSync(join(dir, name), { force: true })
      removed += 1
    } catch {
      // A locked file stays; the next clear can remove it.
    }
  }
  return removed
}

/**
 * One plain-text bundle for **Save reports**.
 *
 * The files are copied verbatim so support can see exactly what the app wrote.
 * They can contain local paths in stack traces, which the caller discloses.
 */
export function buildCrashReportBundle(dir: string, generatedAt = new Date()): string {
  let names: string[] = []
  try {
    // File names begin with the ISO timestamp, so a reverse sort is newest first.
    names = readdirSync(dir).filter(isReportFile).sort().reverse()
  } catch {
    // A missing folder means there is nothing to export.
  }

  const lines = [
    'Suura crash reports',
    `Generated: ${generatedAt.toISOString()}`,
    'Written on this PC. Nothing here was uploaded.',
    'Review this file before sharing it: stack traces can contain local file paths.',
    '',
    `Reports: ${names.length}`
  ]
  for (const name of names) {
    lines.push('', `--- ${name} ---`)
    try {
      lines.push(readFileSync(join(dir, name), 'utf8').trimEnd())
    } catch (cause) {
      lines.push(`(could not read report: ${messageOf(cause)})`)
    }
  }
  return `${lines.join('\n')}\n`
}

export class CrashReporter {
  private installed = false
  private readonly now: () => Date
  private readonly keep: number
  private readonly onException = (error: unknown, origin: string): void => {
    this.record({
      kind: 'main-exception',
      reason: `uncaughtException:${origin}`,
      message: messageOf(error),
      stack: error instanceof Error ? error.stack ?? null : null,
      details: error
    })
  }
  private readonly onRejection = (reason: unknown): void => {
    // Installing this listener suppresses Node's default fatal handling, so the
    // rejection still has to reach the log even when crash reports are off.
    try {
      this.options.log.warn('unhandled rejection in the main process', reason)
    } catch {
      // Logging is best-effort here.
    }
    this.record({
      kind: 'main-rejection',
      reason: 'unhandledRejection',
      message: messageOf(reason),
      stack: reason instanceof Error ? reason.stack ?? null : null,
      details: reason
    })
  }

  constructor(private readonly options: CrashReporterOptions) {
    this.now = options.now ?? (() => new Date())
    this.keep = Math.max(1, Math.floor(options.keep ?? CRASH_REPORT_KEEP))
  }

  /**
   * Hook the main process.
   *
   * `uncaughtExceptionMonitor` observes the exception and then lets Node's
   * normal fatal path run. A plain `uncaughtException` listener would keep a
   * broken process alive, which is worse than the crash it is reporting.
   */
  install(): void {
    if (this.installed) return
    this.installed = true
    process.on('uncaughtExceptionMonitor', this.onException)
    process.on('unhandledRejection', this.onRejection)
  }

  dispose(): void {
    if (!this.installed) return
    this.installed = false
    process.removeListener('uncaughtExceptionMonitor', this.onException)
    process.removeListener('unhandledRejection', this.onRejection)
  }

  /** Writes one report. Returns its path, or null when disabled or unwritable. */
  record(input: CrashReportInput): string | null {
    try {
      if (!this.options.enabled()) return null

      const occurredAt = this.now()
      const id = `${reportName(occurredAt, input.kind).slice(0, -FILE_SUFFIX.length)}-${process.pid}`
      const report: StoredReport = {
        format: 1,
        id,
        occurredAt: occurredAt.toISOString(),
        kind: input.kind,
        reason: text(input.reason, 200) ?? 'unknown',
        message: text(input.message, MAX_MESSAGE),
        stack: text(input.stack, MAX_STACK),
        exitCode:
          typeof input.exitCode === 'number' && Number.isFinite(input.exitCode)
            ? Math.round(input.exitCode)
            : null,
        details: input.details === undefined ? null : safeDetails(input.details, new WeakSet(), 0),
        environment: this.options.environment(),
        process: {
          pid: process.pid,
          uptimeSeconds: Math.round(process.uptime())
        }
      }

      mkdirSync(this.options.dir, { recursive: true })
      const target = this.uniquePath(occurredAt, input.kind)
      writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      this.prune()
      this.options.log.warn('crash report written', { file: target, kind: input.kind, reason: report.reason })
      return target
    } catch (cause) {
      // Reporting must never become the second failure.
      try {
        this.options.log.warn('could not write a crash report', cause)
      } catch {
        // The logger itself is best-effort here.
      }
      return null
    }
  }

  status(): CrashReportsStatus {
    const reports = listCrashReports(this.options.dir)
    return {
      enabled: this.options.enabled(),
      count: reports.length,
      latestAt: reports.length > 0 ? reports[0]?.occurredAt ?? null : null,
      bytes: reports.reduce((sum, report) => sum + report.bytes, 0),
      folder: this.options.dir
    }
  }

  list(): CrashReportSummary[] {
    return listCrashReports(this.options.dir)
  }

  clear(): number {
    return clearCrashReports(this.options.dir)
  }

  bundle(): string {
    return buildCrashReportBundle(this.options.dir, this.now())
  }

  private uniquePath(occurredAt: Date, kind: CrashReportKind): string {
    const base = reportName(occurredAt, kind)
    let target = join(this.options.dir, base)
    if (!existsSync(target)) return target
    const stem = base.slice(0, -FILE_SUFFIX.length)
    for (let index = 2; index < 1000; index += 1) {
      target = join(this.options.dir, `${stem}-${index}${FILE_SUFFIX}`)
      if (!existsSync(target)) return target
    }
    return join(this.options.dir, `${stem}-${Date.now()}${FILE_SUFFIX}`)
  }

  /** Keeps the newest `keep` files, names being timestamp-ordered. */
  private prune(): void {
    try {
      const names = readdirSync(this.options.dir).filter(isReportFile).sort()
      const excess = names.length - this.keep
      if (excess <= 0) return
      for (const name of names.slice(0, excess)) {
        try {
          rmSync(join(this.options.dir, name), { force: true })
        } catch {
          // Keep pruning the rest.
        }
      }
    } catch {
      // A pruning failure does not invalidate the report just written.
    }
  }
}
