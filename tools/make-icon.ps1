# Builds the Windows icon set from one source image.
#
# Source: build/icon-source.png, the square master artwork with transparent
# padding. Outputs:
#
#   build/icon.png         512 px, for the website and store listings
#   build/icon.ico         16/20/24/32/40/48/64/128/256 px PNG frames
#   src/main/tray-icon.ts  32 px PNG, embedded as a data URL
#
# The source is the artwork; this script only scales it. Large reductions are
# done in repeated halves, so a 16 px frame keeps a clean silhouette instead of
# turning to mush in one jump. Every ICO frame is stored as PNG, which Windows
# reads at every size and electron-builder accepts.
#
#   pwsh -File tools/make-icon.ps1
#
# Windows-only, like the release pipeline this feeds.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'build'
New-Item -ItemType Directory -Force -Path $build | Out-Null

$sourcePath = Join-Path $build 'icon-source.png'
if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "Missing icon source: $sourcePath. Put the square master artwork there and run 'npm run icon' again."
}

$source = [System.Drawing.Bitmap]::new($sourcePath)
try {
  if ($source.Width -ne $source.Height) {
    throw "Icon source must be square, but $sourcePath is $($source.Width)x$($source.Height)."
  }
  if ($source.Width -lt 256) {
    throw "Icon source must be at least 256 px, but $sourcePath is $($source.Width) px."
  }

  # One high-quality resize step. SourceCopy plus TileFlipXY keeps the RGB of
  # transparent pixels from bleeding into the edges as a dark fringe.
  function New-Canvas([System.Drawing.Bitmap]$image, [int]$size) {
    $bitmap = [System.Drawing.Bitmap]::new(
      $size,
      $size,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $attributes = [System.Drawing.Imaging.ImageAttributes]::new()
      try {
        $attributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
        $rect = [System.Drawing.Rectangle]::new(0, 0, $size, $size)
        $graphics.DrawImage(
          $image,
          $rect,
          0,
          0,
          $image.Width,
          $image.Height,
          [System.Drawing.GraphicsUnit]::Pixel,
          $attributes
        )
      } finally {
        $attributes.Dispose()
      }
    } finally {
      $graphics.Dispose()
    }
    return $bitmap
  }

  # Halve until the next step would undershoot, then take the exact final size.
  # The caller owns the returned bitmap and disposes it.
  function ConvertTo-IconSize([System.Drawing.Bitmap]$image, [int]$size) {
    $current = $image
    $owned = $false
    while ($current.Width -ge ($size * 2)) {
      $nextSize = [int][math]::Ceiling($current.Width / 2.0)
      if ($nextSize -lt $size) { $nextSize = $size }
      $next = New-Canvas $current $nextSize
      if ($owned) { $current.Dispose() }
      $current = $next
      $owned = $true
    }
    if ($current.Width -ne $size) {
      $next = New-Canvas $current $size
      if ($owned) { $current.Dispose() }
      $current = $next
      $owned = $true
    }
    return $current
  }

  function Get-PngBytes([System.Drawing.Bitmap]$bitmap) {
    $stream = [System.IO.MemoryStream]::new()
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $stream.ToArray()
    $stream.Dispose()
    # The comma stops PowerShell unrolling the array into one pipeline object
    # per byte, which would turn the ICO frames into a stream of single bytes.
    return , $bytes
  }

  # A 512 px PNG for the website and store listings; Windows uses the ICO.
  $preview = ConvertTo-IconSize $source 512
  try {
    $preview.Save((Join-Path $build 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $preview.Dispose()
  }

  # One frame per size Explorer can ask for. 256 is stored as PNG, as required
  # for that entry; the rest are PNG too, which every supported Windows version
  # reads.
  $sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
  $frames = foreach ($size in $sizes) {
    $bitmap = ConvertTo-IconSize $source $size
    try {
      $png = Get-PngBytes $bitmap
    } finally {
      $bitmap.Dispose()
    }
    [pscustomobject]@{ Size = $size; Png = $png }
  }

  $icoPath = Join-Path $build 'icon.ico'
  $file = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create)
  $writer = [System.IO.BinaryWriter]::new($file)
  try {
    $writer.Write([uint16]0)                 # reserved
    $writer.Write([uint16]1)                 # type: icon
    $writer.Write([uint16]$frames.Count)     # image count

    $offset = 6 + (16 * $frames.Count)
    foreach ($frame in $frames) {
      $dimension = if ($frame.Size -ge 256) { 0 } else { $frame.Size }
      $writer.Write([byte]$dimension)        # width
      $writer.Write([byte]$dimension)        # height
      $writer.Write([byte]0)                 # palette entries
      $writer.Write([byte]0)                 # reserved
      $writer.Write([uint16]1)               # colour planes
      $writer.Write([uint16]32)              # bits per pixel
      $writer.Write([uint32]$frame.Png.Length)
      $writer.Write([uint32]$offset)
      $offset += $frame.Png.Length
    }
    foreach ($frame in $frames) {
      $writer.Write([byte[]]$frame.Png)
    }
  } finally {
    $writer.Dispose()
    $file.Dispose()
  }

  # The tray icon lives as a base64 string inside the main bundle, because the
  # packaged app has no public asset folder to read from. Regenerate it from the
  # same source so the tray, the window and the installer cannot drift.
  $trayBitmap = ConvertTo-IconSize $source 32
  try {
    $trayPng = Get-PngBytes $trayBitmap
  } finally {
    $trayBitmap.Dispose()
  }
  $trayBase64 = [System.Convert]::ToBase64String($trayPng)
  $traySource = @"
/**
 * The tray icon, embedded rather than loaded from disk.
 *
 * Generated by tools/make-icon.ps1 (``npm run icon``) from build/icon-source.png,
 * the same artwork as build/icon.ico, so the tray and the window never disagree.
 * Do not edit the base64 by hand.
 *
 * Electron's tray needs a bitmap, and the main bundle has no public directory
 * that would survive packaging. A 32 px PNG keeps the mark self-contained in
 * both dev and the installer, and gives Windows a 2x source for scaled trays.
 */
export const TRAY_ICON_DATA_URL =
  'data:image/png;base64,$trayBase64'
"@
  Set-Content -Path (Join-Path $root 'src/main/tray-icon.ts') -Value $traySource -Encoding utf8 -NoNewline
} finally {
  $source.Dispose()
}

Write-Output "wrote build/icon.png (512), build/icon.ico ($($sizes.Count) frames) and src/main/tray-icon.ts"
