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
 * count and SHA-256 together. `tools/smoke.ts` checks that every row, on every
 * platform, is internally consistent.
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
  kind: 'file' | 'zip' | 'tar.gz'
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

const WINDOWS_ASSETS: readonly SidecarAsset[] = [
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

const LINUX_ASSETS: readonly SidecarAsset[] = [
  {
    id: 'yt-dlp',
    version: '2026.10.26',
    // The PyInstaller build for x86_64; the `_aarch64` and `.zip` variants are
    // different files with different digests, so the name is part of the pin.
    url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux',
    sha256: '767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795',
    bytes: 41_166_968,
    file: 'yt-dlp',
    kind: 'file',
    license: 'Unlicense'
  },
  {
    id: 'ffmpeg',
    version: '6.1.1',
    url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64',
    sha256: 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99',
    bytes: 79_826_272,
    file: 'ffmpeg',
    kind: 'file',
    license: 'GPL-3.0-or-later'
  },
  {
    id: 'fpcalc',
    version: '1.6.2',
    // AcoustID ships Linux only as a `.tar.gz`; the member inside it is the
    // binary, and the tar reader is the one this row added.
    url: 'https://github.com/acoustid/chromaprint/releases/download/v1.6.2/chromaprint-fpcalc-1.6.2-linux-x86_64.tar.gz',
    sha256: 'c968ad4a0821592a79b158fb2e1f46cbe0a22a0a1dbc0743c67d68e75d15d2bb',
    bytes: 2_398_043,
    file: 'fpcalc',
    kind: 'tar.gz',
    entry: 'chromaprint-fpcalc-1.6.2-linux-x86_64/fpcalc',
    license: 'LGPL-2.1-or-later',
    optional: true
  }
]

const ASSETS_BY_PLATFORM: Partial<Record<NodeJS.Platform, readonly SidecarAsset[]>> = {
  win32: WINDOWS_ASSETS,
  linux: LINUX_ASSETS
}

/** Every table, for the smoke test that checks the rows a release build will not use. */
export function sidecarAssetsByPlatform(): Record<string, readonly SidecarAsset[]> {
  return { win32: WINDOWS_ASSETS, linux: LINUX_ASSETS }
}

/**
 * The rows for one platform.
 *
 * A platform with no table is a refusal, not a fallback: an app that shipped
 * Windows binaries on Linux would fail at the first spawn with a confusing
 * `ENOEXEC` instead of saying what is wrong.
 */
export function assetsForPlatform(platform: NodeJS.Platform): readonly SidecarAsset[] {
  const assets = ASSETS_BY_PLATFORM[platform]
  if (!assets) throw new Error(`No sidecar set is defined for ${platform}.`)
  return assets
}

/** What this build downloads. */
export const SIDECAR_ASSETS: readonly SidecarAsset[] = assetsForPlatform(process.platform)

export function sidecarAsset(id: SidecarId): SidecarAsset {
  const asset = SIDECAR_ASSETS.find((candidate) => candidate.id === id)
  if (!asset) throw new Error(`No sidecar is defined for ${process.platform} and ${id}.`)
  return asset
}
