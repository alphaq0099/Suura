import type { EngineSettings, EngineStatus } from '@shared/types'
import { probeExecutable } from './locate'

/**
 * Reports whether the yt-dlp engine's dependencies are present and runnable.
 *
 * Nothing in M0.5 uses yt-dlp to play music. This exists so the riskiest part of
 * the roadmap (ROADMAP.md §6.4) is visible from day one: if the user's yt-dlp is
 * missing, too old, or shadowed by a broken wrapper, the settings screen says so
 * instead of the first M3 playback attempt failing mysteriously.
 */
export async function getEngineStatus(engine: EngineSettings): Promise<EngineStatus> {
  const [ytDlp, ffmpeg] = await Promise.all([
    probeExecutable('yt-dlp', { configuredDir: engine.binDir }),
    // ffmpeg prints its banner to stdout and expects a flag, not --version alone.
    probeExecutable('ffmpeg', { configuredDir: engine.binDir, versionArgs: ['-version'] })
  ])

  return {
    ytDlp,
    ffmpeg,
    ready: ytDlp.found && ffmpeg.found
  }
}
