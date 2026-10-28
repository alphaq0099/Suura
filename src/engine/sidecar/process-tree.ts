import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Stops a sidecar and everything it started.
 *
 * yt-dlp can leave a deno/ffmpeg child behind, and a provider command such as
 * `npm run start` can leave the real server behind when only the shell is
 * killed. Windows has no process groups here, so `taskkill /T` is the honest
 * option; elsewhere the direct child is the process we own.
 */
export function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    killer.on('error', () => undefined)
    killer.unref()
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // It exited between the check and the kill.
  }
}
