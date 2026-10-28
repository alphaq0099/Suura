# Generates build/icon.png and build/icon.ico without a design tool.
#
# The mark is deliberately simple: a rounded midnight square, a blue-to-cyan
# diagonal wash and a white play triangle. It has to read at 16px in the tray
# and at 256px in the installer, so there is no small detail in it.
#
#   pwsh -File tools/make-icon.ps1
#
# Windows-only, like the release pipeline this feeds.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'build'
New-Item -ItemType Directory -Force -Path $build | Out-Null

$size = 256
$bitmap = New-Object System.Drawing.Bitmap($size, $size)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

# Rounded square: radius 56 leaves a deliberate margin around the mark.
$radius = 56
$rect = New-Object System.Drawing.RectangleF(8, 8, ($size - 16), ($size - 16))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$diameter = $radius * 2
$path.AddArc($rect.X, $rect.Y, $diameter, $diameter, 180, 90)
$path.AddArc(($rect.Right - $diameter), $rect.Y, $diameter, $diameter, 270, 90)
$path.AddArc(($rect.Right - $diameter), ($rect.Bottom - $diameter), $diameter, $diameter, 0, 90)
$path.AddArc($rect.X, ($rect.Bottom - $diameter), $diameter, $diameter, 90, 90)
$path.CloseFigure()

$background = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  [System.Drawing.Color]::FromArgb(255, 13, 20, 38),
  [System.Drawing.Color]::FromArgb(255, 17, 34, 64),
  45
)
$graphics.FillPath($background, $path)
$background.Dispose()

$wash = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  [System.Drawing.Color]::FromArgb(230, 37, 99, 235),
  [System.Drawing.Color]::FromArgb(90, 34, 211, 238),
  35
)
$graphics.FillPath($wash, $path)
$wash.Dispose()

# A soft inner border keeps the icon from dissolving into a dark taskbar.
$border = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(70, 255, 255, 255), 3)
$graphics.DrawPath($border, $path)
$border.Dispose()

$triangle = @(
  (New-Object System.Drawing.PointF(96, 76)),
  (New-Object System.Drawing.PointF(188, 128)),
  (New-Object System.Drawing.PointF(96, 180))
)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 248, 250, 252))
$graphics.FillPolygon($white, $triangle)
$white.Dispose()

$bitmap.Save((Join-Path $build 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)

# Icon.FromHandle writes the bitmap's native size as a single 32bpp frame. The
# installer and Explorer both scale this down cleanly.
$handle = $bitmap.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($handle)
$stream = [System.IO.File]::Open((Join-Path $build 'icon.ico'), [System.IO.FileMode]::Create)
$icon.Save($stream)
$stream.Close()
$icon.Dispose()

$graphics.Dispose()
$bitmap.Dispose()

Write-Output "wrote build/icon.png and build/icon.ico"
