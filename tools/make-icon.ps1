# Generates build/icon.png and build/icon.ico without a design tool.
#
# The mark is a waveform in a rounded tile: five rounded bars on a smooth
# envelope, with a shorter three-bar variant at the sizes where five would turn
# to mush. Every ICO frame is rendered at its own size and stored as PNG, which
# keeps edges crisp in Explorer, the taskbar and the installer.
#
#   pwsh -File tools/make-icon.ps1
#
# Windows-only, like the release pipeline this feeds.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'build'
New-Item -ItemType Directory -Force -Path $build | Out-Null

# Everything is drawn in a 256-unit space and scaled by the graphics transform,
# so one set of coordinates serves every frame.
$unit = 256.0

function New-RoundedPath([double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-IconBitmap([int]$size) {
  $bitmap = [System.Drawing.Bitmap]::new(
    $size,
    $size,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.ScaleTransform(($size / $unit), ($size / $unit))

  # The tile: a deep midnight square with a periwinkle-to-teal wash, the two
  # accents the app ships with. 8 units of margin keeps the silhouette from
  # touching the edge of the icon box.
  $tile = New-RoundedPath 8 8 240 240 54
  $baseRect = [System.Drawing.RectangleF]::new(8, 8, 240, 240)
  $base = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $baseRect,
    [System.Drawing.Color]::FromArgb(255, 13, 20, 36),
    [System.Drawing.Color]::FromArgb(255, 22, 32, 58),
    45
  )
  $graphics.FillPath($base, $tile)
  $base.Dispose()

  $wash = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $baseRect,
    [System.Drawing.Color]::FromArgb(205, 79, 107, 255),
    [System.Drawing.Color]::FromArgb(150, 47, 179, 168),
    45
  )
  $graphics.FillPath($wash, $tile)
  $wash.Dispose()

  # A soft inner edge stops the tile dissolving into a dark taskbar.
  $edge = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(48, 255, 255, 255), 3.5)
  $graphics.DrawPath($edge, $tile)
  $edge.Dispose()
  $tile.Dispose()

  # The mark. Five rounded bars on a smooth envelope: the centre bar is the
  # loudest, so it reads as audio rather than as a rising or falling signal.
  # Bars are centred on y = 128.
  $bars = if ($size -le 24) {
    @(
      @{ x = 36.0; w = 44.0; h = 88.0 },
      @{ x = 106.0; w = 44.0; h = 152.0 },
      @{ x = 176.0; w = 44.0; h = 88.0 }
    )
  } else {
    @(
      @{ x = 22.0; w = 28.0; h = 58.0 },
      @{ x = 68.0; w = 28.0; h = 112.0 },
      @{ x = 114.0; w = 28.0; h = 152.0 },
      @{ x = 160.0; w = 28.0; h = 112.0 },
      @{ x = 206.0; w = 28.0; h = 58.0 }
    )
  }

  $ink = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 247, 250, 255))
  foreach ($bar in $bars) {
    $pill = New-RoundedPath $bar.x (128.0 - ($bar.h / 2.0)) $bar.w $bar.h ($bar.w / 2.0)
    $graphics.FillPath($ink, $pill)
    $pill.Dispose()
  }
  $ink.Dispose()

  $graphics.Dispose()
  return $bitmap
}

function Get-PngBytes([System.Drawing.Bitmap]$bitmap) {
  $stream = [System.IO.MemoryStream]::new()
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $stream.ToArray()
  $stream.Dispose()
  # The comma stops PowerShell unrolling the array into one pipeline object per
  # byte, which would turn the ICO frames into a stream of single bytes.
  return , $bytes
}

# A 512 px PNG for the website and store listings; Windows uses the ICO.
$preview = New-IconBitmap 512
$preview.Save((Join-Path $build 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$preview.Dispose()

# One frame per size Explorer can ask for. 256 is stored as PNG, as required for
# that entry; the rest are PNG too, which every supported Windows version reads.
$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$frames = foreach ($size in $sizes) {
  $bitmap = New-IconBitmap $size
  $png = Get-PngBytes $bitmap
  $bitmap.Dispose()
  [pscustomobject]@{ Size = $size; Png = $png }
}

$icoPath = Join-Path $build 'icon.ico'
$file = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create)
$writer = [System.IO.BinaryWriter]::new($file)
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

$writer.Dispose()
$file.Dispose()

# The tray icon lives as a base64 string inside the main bundle, because the
# packaged app has no public asset folder to read from. Regenerate it from the
# same drawing code so the tray, the window and the installer cannot drift.
$trayBitmap = New-IconBitmap 32
$trayPng = Get-PngBytes $trayBitmap
$trayBitmap.Dispose()
$trayBase64 = [System.Convert]::ToBase64String($trayPng)
$traySource = @"
/**
 * The tray icon, embedded rather than loaded from disk.
 *
 * Generated by tools/make-icon.ps1 (``npm run icon``) from the same drawing code
 * as build/icon.ico, so the tray and the window never disagree. Do not edit the
 * base64 by hand.
 *
 * Electron's tray needs a bitmap, and the main bundle has no public directory
 * that would survive packaging. A 32 px PNG keeps the mark self-contained in
 * both dev and the installer, and gives Windows a 2x source for scaled trays.
 */
export const TRAY_ICON_DATA_URL =
  'data:image/png;base64,$trayBase64'
"@
Set-Content -Path (Join-Path $root 'src/main/tray-icon.ts') -Value $traySource -Encoding utf8 -NoNewline

Write-Output "wrote build/icon.png (512), build/icon.ico ($($frames.Count) frames) and src/main/tray-icon.ts"
