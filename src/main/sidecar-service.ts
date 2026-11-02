import type { Logger } from '@core/logging/logger'
import type {
  SidecarId,
  SidecarInstallResult,
  SidecarProgress,
  SidecarState
} from '@shared/types'
import { installAsset, sidecarStates } from '@engine/sidecar/install'
import { SIDECAR_ASSETS, type SidecarAsset } from '@engine/sidecar/manifest'

/**
 * Owns the one engine download at a time.
 *
 * The engine is fetched on first use rather than bundled, so this is the only
 * thing that writes into the app-managed engine folder. Two Settings clicks (or
 * a click and a retry) share one run instead of racing each other for the same
 * temporary files.
 */
export class SidecarService {
  private run: Promise<SidecarInstallResult> | null = null
  private controller: AbortController | null = null

  constructor(
    private readonly deps: {
      dir: string
      log: Logger
      onProgress?: (progress: SidecarProgress) => void
      assets?: readonly SidecarAsset[]
    }
  ) {}

  get directory(): string {
    return this.deps.dir
  }

  private get assets(): readonly SidecarAsset[] {
    return this.deps.assets ?? SIDECAR_ASSETS
  }

  states(): Promise<SidecarState[]> {
    return sidecarStates(this.deps.dir, this.assets)
  }

  /** True when every asset that streaming needs is on disk. */
  async ready(): Promise<boolean> {
    const states = await this.states()
    return states.filter((state) => !state.optional).every((state) => state.installed)
  }

  install(): Promise<SidecarInstallResult> {
    if (this.run) return this.run
    const controller = new AbortController()
    this.controller = controller

    const work = this.installAll(controller.signal).finally(() => {
      this.run = null
      this.controller = null
    })
    this.run = work
    return work
  }

  /** Stops the current download; the partial file is removed by the installer. */
  cancel(): void {
    this.controller?.abort()
  }

  private async installAll(signal: AbortSignal): Promise<SidecarInstallResult> {
    const installed: SidecarId[] = []
    const failed: { id: SidecarId; message: string }[] = []

    for (const asset of this.assets) {
      if (signal.aborted) return { installed, failed, cancelled: true }
      try {
        const outcome = await installAsset(asset, {
          dir: this.deps.dir,
          log: this.deps.log,
          signal,
          onProgress: this.deps.onProgress
        })
        if (outcome.installed) installed.push(asset.id)
      } catch (error) {
        if (signal.aborted) return { installed, failed, cancelled: true }
        const message = error instanceof Error ? error.message : String(error)
        failed.push({ id: asset.id, message })
        this.deps.log.warn('sidecar install failed', { id: asset.id, message })
        // One required failure usually means the network is down or the link
        // moved; trying the next 80 MB file would just repeat the wait.
        if (!asset.optional) break
      }
    }

    return { installed, failed, cancelled: signal.aborted }
  }
}
