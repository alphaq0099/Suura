import type { SidecarId } from '@shared/types'

/**
 * The exact upstream artifacts the app downloads on first use.
 *
 * Nothing here is bundled: the installer stays small, and the user gets the
 * official binaries from the project that publishes them. That also keeps the
 * licence question simple - the app does not redistribute them. Each binary
 * still carries its own licence (`license` below is shown in the docs).
 *
 * A row is a promise, not a hint: the URL must be immutable, and the digest is
 * the only thing that decides whether the download is accepted. Do not point a
 * row at a rolling tag such as BtbN's `latest` or at a file that upstream
 * replaces in place; a checksum pinned to such a URL fails the day it changes,
 * and the user sees "the download did not match" for a server-side reason.
 *
 * Updating a sidecar is therefore a code change: bump the version, URL, byte
 * count and SHA-256 together. `tools/smoke.ts` checks that the row is
 * internally consistent.
 */
export interface SidecarAsset {
  id: SidecarId
  /** Upstream version, shown in Settings. */
  version: string
  /** An immutable release URL. */
  url: string
  /** Lower-case hex SHA-256 of the downloaded bytes. */
  sha256: string
  /** Exact download size, so a truncated transfer fails early. */
  bytes: number
  /** Name the binary gets in the engine folder. */
  file: string
  /** How a download becomes the binary. */
  kind: 'file' | 'zip'
  /** For a zip, the exact member to extract. Never a pattern. */
  entry?: string
  /** SPDX identifier of the build being downloaded. */
  license: string
  /**
   * Optional assets do not block streaming when they fail: `fpcalc` is only
   * needed for fingerprinting, which is a later milestone.
   */
  optional?: boolean
}

export const SIDECAR_ASSETS: readonly SidecarAsset[] = [
  {
    id: 'yt-dlp',
    version: '2026.10.26',
    url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe',
    sha256: 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d',
    bytes: 23_575_744,
    file: 'yt-dlp.exe',
    kind: 'file',
    license: 'Unlicense'
  },
  {
    // The ffmpeg version, not the ffmpeg-static release tag (b6.1.1).
    // ffmpeg-static's releases are versioned and immutable, unlike the Windows
    // builds that publish rolling `latest` tags or prune dated autobuilds.
    id: 'ffmpeg',
    version: '6.1.1',
    url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64',
    sha256: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
    bytes: 82_797_568,
    file: 'ffmpeg.exe',
    kind: 'file',
    license: 'GPL-3.0-or-later'
  },
  {
    id: 'fpcalc',
    version: '1.6.2',
    url: 'https://github.com/acoustid/chromaprint/releases/download/v1.6.2/chromaprint-fpcalc-1.6.2-windows-x86_64.zip',
    sha256: 'b74369726676670af3ab0eadff45f960cf969fdf4a87a971ba37eaf8d530e874',
    bytes: 1_817_825,
    file: 'fpcalc.exe',
    kind: 'zip',
    entry: 'chromaprint-fpcalc-1.6.2-windows-x86_64/fpcalc.exe',
    license: 'LGPL-2.1-or-later',
    optional: true
  }
]

export function sidecarAsset(id: SidecarId): SidecarAsset {
  const asset = SIDECAR_ASSETS.find((candidate) => candidate.id === id)
  if (!asset) throw new Error(`No sidecar is defined for ${id}.`)
  return asset
}
