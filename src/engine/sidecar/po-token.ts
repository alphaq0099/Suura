import { spawn, type ChildProcess } from 'node:child_process'
import type { Logger } from '@core/logging/logger'
import type { EngineSettings, PoTokenStatus } from '@shared/types'
import { DEFAULT_PO_TOKEN_PROVIDER_URL, normalizePoTokenProviderUrl } from '@shared/youtube'
import { killTree } from './process-tree'

/**
 * Splits a user-supplied command line into argv without invoking a shell.
 *
 * The provider command is advanced, opt-in configuration. Avoiding a shell
 * means `&`, `|`, `%VAR%` and friends are ordinary characters rather than ways
 * to run something else. Quotes group an argument; backslashes are literal
 * except before a quote, a backslash or whitespace, which is what keeps a
 * Windows path like `C:\tools\server.js` intact.
 */
export function splitCommandLine(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? ''
    const next = input[index + 1] ?? ''

    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === '\\' && quote !== "'" && /["'\\\s]/.test(next)) {
      escaped = true
      continue
    }

    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (escaped) current += '\\'
  if (quote) throw new Error('The provider command has an unclosed quote.')
  if (current.length > 0) args.push(current)
  return args
}

// The bgutil provider loads jsdom and its dependency tree (thousands of files)
// before it binds its port. A warm start takes a few seconds; the first start
// after a reboot can take far longer because nothing is cached and the virus
// scanner reads every file for the first time. So the first deadline only ends
// the wait, never the process: a child that is still loading is reported as
// still starting and keeps being watched until it answers.
const START_WAIT_MS = 45_000
const GIVE_UP_MS = 180_000
const PING_TIMEOUT_MS = 2_000
const STOP_WAIT_MS = 2_000
const MAX_LOG_TAIL = 4_000

/**
 * Supervises an external PO Token provider.
 *
 * This is intentionally a manager, not a token generator. The actual provider
 * and the yt-dlp plugin are third-party pieces the user installs; the app only
 * starts a command the user configured, reports whether the HTTP endpoint
 * answers, and tells yt-dlp where that endpoint is. Nothing is downloaded or
 * bundled here.
 */
export class PoTokenProvider {
  private child: ChildProcess | null = null
  private starting: Promise<PoTokenStatus> | null = null
  private lastError: string | null = null
  private stderrTail = ''
  private stopping = false

  constructor(
    private readonly deps: {
      engine: () => EngineSettings
      log: Logger
      // Overridable so the smoke test can watch a slow start without waiting
      // minutes; the app always uses the defaults above.
      readyWaitMs?: number
      giveUpMs?: number
    }
  ) {}

  private get readyWaitMs(): number {
    return this.deps.readyWaitMs ?? START_WAIT_MS
  }

  private get giveUpMs(): number {
    return this.deps.giveUpMs ?? GIVE_UP_MS
  }

  /** Reads the current switch, URL and process state, then probes `/ping`. */
  async status(): Promise<PoTokenStatus> {
    const engine = this.deps.engine()
    const providerUrl =
      normalizePoTokenProviderUrl(engine.poTokenProviderUrl) ?? DEFAULT_PO_TOKEN_PROVIDER_URL
    const probe = await this.ping(providerUrl)
    if (probe.reachable) this.lastError = null
    return {
      enabled: engine.poTokenEnabled,
      providerUrl,
      managedRunning: this.child !== null,
      serverReachable: probe.reachable,
      serverVersion: probe.version,
      commandConfigured: Boolean(engine.poTokenProviderCommand?.trim()),
      error: this.lastError
    }
  }

  /**
   * Starts the configured command and waits for its HTTP endpoint.
   *
   * If a provider is already answering, no second process is started. That
   * makes the button safe to press when the user runs the server themselves.
   */
  async start(): Promise<PoTokenStatus> {
    if (this.starting) return this.starting
    const engine = this.deps.engine()
    if (!engine.poTokenEnabled) {
      throw new Error('Enable the PO Token provider before starting it.')
    }

    const providerUrl =
      normalizePoTokenProviderUrl(engine.poTokenProviderUrl) ?? DEFAULT_PO_TOKEN_PROVIDER_URL
    if (await this.isReachable(providerUrl)) return this.status()
    if (this.child) return this.status()

    const commandLine = engine.poTokenProviderCommand?.trim() ?? ''
    if (commandLine.length === 0) {
      throw new Error('Set a provider command before starting it, or run the provider yourself.')
    }

    const argv = splitCommandLine(commandLine)
    const command = argv[0]
    if (!command) throw new Error('The provider command is empty.')
    const args = argv.slice(1)

    // The switch can be turned off while the reachability probe is in flight.
    if (!this.deps.engine().poTokenEnabled) {
      throw new Error('The PO Token provider was disabled before it started.')
    }

    this.lastError = null
    this.stderrTail = ''
    this.stopping = false

    const work = this.launch(command, args, providerUrl)
    this.starting = work
    try {
      return await work
    } finally {
      this.starting = null
    }
  }

  /** Stops the process this app started; an external server is left alone. */
  async stop(): Promise<PoTokenStatus> {
    const child = this.child
    this.child = null
    if (child) {
      this.stopping = true
      const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
      killTree(child)
      await Promise.race([exited, delay(STOP_WAIT_MS)])
      // Leave `stopping` set. If taskkill needed longer than the wait, a late
      // close must not be reported as a provider crash; the next start clears it.
    }
    return this.status()
  }

  /**
   * Stops a managed process only when there is one.
   *
   * This is the settings-change path. Calling `stop()` unconditionally would
   * probe the provider URL after every settings write, which is both pointless
   * and a surprising amount of network activity while the user drags a slider.
   */
  stopIfManaged(): void {
    if (!this.child) return
    void this.stop()
  }

  /** Synchronous cleanup for app shutdown, where the event loop is closing. */
  dispose(): void {
    const child = this.child
    this.child = null
    if (child) {
      this.stopping = true
      killTree(child)
    }
  }

  /** Called at startup and when the relevant settings change. */
  maybeAutoStart(): void {
    const engine = this.deps.engine()
    if (!engine.poTokenEnabled || !engine.poTokenAutoStart) return
    if (!engine.poTokenProviderCommand?.trim()) return
    void this.start().catch((error) => {
      this.deps.log.warn('PO Token provider did not auto-start', error)
    })
  }

  private async launch(command: string, args: string[], providerUrl: string): Promise<PoTokenStatus> {
    this.deps.log.info('starting PO Token provider', { command, args, providerUrl })

    let child: ChildProcess
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError = `Could not start the PO Token provider: ${message}`
      throw new Error(this.lastError)
    }

    this.child = child
    this.deps.log.debug('PO Token provider process started', { pid: child.pid ?? null })
    child.stdout?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-MAX_LOG_TAIL)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-MAX_LOG_TAIL)
    })
    child.on('error', (error) => {
      this.lastError = `Could not start the PO Token provider: ${error.message}`
      if (this.child === child) this.child = null
    })
    child.on('close', (code) => {
      if (this.child === child) this.child = null
      if (this.stopping) return
      if (code !== 0) {
        const tail = this.stderrTail.trim()
        this.lastError = `The PO Token provider exited with code ${code}.${tail ? ` ${tail}` : ''}`
        this.deps.log.warn('PO Token provider exited', { code, output: tail.slice(-1000) })
      }
    })

    const startedAt = Date.now()
    const deadline = startedAt + this.readyWaitMs
    while (Date.now() < deadline) {
      if (this.child === null) {
        throw new Error(this.lastError ?? 'The PO Token provider exited before it was ready.')
      }
      if (await this.isReachable(providerUrl)) {
        this.lastError = null
        return this.status()
      }
      await delay(250)
    }

    if (this.child === null) {
      throw new Error(this.lastError ?? 'The PO Token provider exited before it was ready.')
    }

    // Still loading is not the same as broken, so the first deadline only ends
    // the wait. Returning here keeps the caller responsive, and the watcher
    // picks the provider up whenever it finally binds.
    this.deps.log.warn('PO Token provider is still starting', {
      providerUrl,
      pid: this.child.pid ?? null,
      waitedMs: Date.now() - startedAt
    })
    this.watch(this.child, providerUrl, startedAt)
    return this.status()
  }

  /**
   * Watches a child that was still loading when the first wait ended.
   *
   * The process is only killed when the give-up deadline passes, so a cold
   * start that needs a minute is slow rather than fatal. The loops also end as
   * soon as the child exits or is stopped, and a later child is never confused
   * with this one.
   */
  private watch(child: ChildProcess, providerUrl: string, startedAt: number): void {
    const giveUpAt = startedAt + this.giveUpMs
    void (async () => {
      while (this.child === child) {
        if (await this.isReachable(providerUrl)) {
          this.lastError = null
          this.deps.log.info('PO Token provider is ready', {
            providerUrl,
            pid: child.pid ?? null,
            waitedMs: Date.now() - startedAt
          })
          return
        }
        if (Date.now() >= giveUpAt) {
          const tail = this.stderrTail.trim()
          this.lastError = `The PO Token provider did not answer at ${providerUrl} within ${Math.round(
            this.giveUpMs / 1000
          )} seconds.${tail ? ` Output: ${tail.slice(-1000)}` : ''}`
          this.deps.log.warn('PO Token provider never answered', {
            providerUrl,
            pid: child.pid ?? null,
            waitedMs: Date.now() - startedAt,
            output: tail.slice(-1000)
          })
          this.dispose()
          return
        }
        await delay(1000)
      }
    })()
  }

  private async isReachable(providerUrl: string): Promise<boolean> {
    return (await this.ping(providerUrl)).reachable
  }

  private async ping(providerUrl: string): Promise<{ reachable: boolean; version: string | null }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS)
    try {
      const response = await fetch(`${providerUrl}/ping`, {
        signal: controller.signal,
        headers: { accept: 'application/json' }
      })
      if (!response.ok) return { reachable: false, version: null }
      const body = (await response.json()) as { version?: unknown }
      return {
        reachable: true,
        version: typeof body.version === 'string' ? body.version : null
      }
    } catch {
      return { reachable: false, version: null }
    } finally {
      clearTimeout(timer)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
