import type { PlayerApi } from '@shared/ipc'

declare global {
  interface Window {
    /** Defined by the preload bridge (src/preload/index.ts). */
    player?: PlayerApi
  }
}

export {}
