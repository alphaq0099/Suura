# Publishes one Windows release to an R2 bucket that serves the update feed.
#
#   npx wrangler login                                   (once, or set CLOUDFLARE_API_TOKEN)
#   pwsh -File tools/publish-r2.ps1 -Bucket surra -BaseUrl https://pub-xxxx.r2.dev
#
# The bucket must be publicly readable through a custom domain or its r2.dev
# subdomain; a private bucket makes the feed useless even when the upload works.
# The app reads the folder configured in Settings -> About, so the base URL here
# is the same URL a user pastes there.
#
# Uploads exactly the four files electron-builder wrote for the current version:
# the installer, its blockmap, the channel file (latest.yml or beta.yml) and
# SHA256SUMS.txt. Versioned filenames are cached forever; the channel file and
# checksums are always revalidated so a new release is seen immediately.
#
#   pwsh -File tools/publish-r2.ps1 -Bucket surra -BaseUrl https://... -DryRun
#
# Windows-only, like the release pipeline this feeds.

[CmdletBinding()]
param(
  # R2 bucket name. The one created for Suura is `surra` (one u).
  [string]$Bucket = 'surra',
  # Optional key prefix, for example `stable`. Empty means the bucket root.
  [string]$Prefix = '',
  # Needed when the Wrangler login has access to more than one account.
  [string]$AccountId = $env:CLOUDFLARE_ACCOUNT_ID,
  # Public base URL of the bucket or prefix, used for the final check.
  [string]$BaseUrl,
  # Where electron-builder wrote the release. Defaults to <repo>/release.
  [string]$ReleaseDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release'),
  # Print the uploads without sending them.
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$packageJson = Join-Path $root 'package.json'
if (-not (Test-Path -LiteralPath $packageJson)) {
  throw "Cannot find $packageJson. Run this from a Suura checkout."
}

$version = (Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json).version
$channelFile = if ($version -match '-') { 'beta.yml' } else { 'latest.yml' }
$installer = "Suura-$version-Setup.exe"

if (-not (Test-Path -LiteralPath $ReleaseDir)) {
  throw "Missing release folder: $ReleaseDir. Run 'npm run package:win' first."
}

$files = @(
  [pscustomobject]@{
    Name = $installer
    Key = $installer
    ContentType = 'application/octet-stream'
    CacheControl = 'public, max-age=31536000, immutable'
  },
  [pscustomobject]@{
    Name = "$installer.blockmap"
    Key = "$installer.blockmap"
    ContentType = 'application/octet-stream'
    CacheControl = 'public, max-age=31536000, immutable'
  },
  [pscustomobject]@{
    Name = $channelFile
    Key = $channelFile
    ContentType = 'text/yaml; charset=utf-8'
    CacheControl = 'no-cache, max-age=0, must-revalidate'
  },
  [pscustomobject]@{
    Name = 'SHA256SUMS.txt'
    Key = 'SHA256SUMS.txt'
    ContentType = 'text/plain; charset=utf-8'
    CacheControl = 'no-cache, max-age=0, must-revalidate'
  },
  # Stable alias so the landing page can link to one URL release after release.
  # It must be revalidated because the object behind it changes every version.
  [pscustomobject]@{
    Name = $installer
    Key = 'Suura-Setup.exe'
    ContentType = 'application/octet-stream'
    CacheControl = 'no-cache, max-age=0, must-revalidate'
  }
)

foreach ($file in $files) {
  $path = Join-Path $ReleaseDir $file.Name
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing $($file.Name) in $ReleaseDir. Run 'npm run package:win' and write SHA256SUMS.txt first."
  }
  $file | Add-Member -NotePropertyName Path -NotePropertyValue $path
  $file | Add-Member -NotePropertyName Length -NotePropertyValue (Get-Item -LiteralPath $path).Length
}

# The channel file and the checksum must describe this exact installer. A
# mismatch here is the failure the updater would otherwise hit after download.
$channelPath = Join-Path $ReleaseDir $channelFile
$channelText = Get-Content -LiteralPath $channelPath -Raw
if ($channelText -notmatch [regex]::Escape($installer)) {
  throw "$channelFile does not name $installer. Repackage before publishing."
}

$sizeMatch = [regex]::Match($channelText, '(?m)^\s*size:\s*(\d+)\s*$')
if ($sizeMatch.Success) {
  $declaredSize = [int64]$sizeMatch.Groups[1].Value
  $actualSize = Get-Item -LiteralPath (Join-Path $ReleaseDir $installer) | Select-Object -ExpandProperty Length
  if ($declaredSize -ne $actualSize) {
    throw "$channelFile says $declaredSize bytes but $installer is $actualSize bytes. Repackage before publishing."
  }
}

$sumPath = Join-Path $ReleaseDir 'SHA256SUMS.txt'
$sumLine = Get-Content -LiteralPath $sumPath |
  Where-Object { $_ -match [regex]::Escape($installer) } |
  Select-Object -First 1
if (-not $sumLine) {
  throw "SHA256SUMS.txt has no line for $installer."
}
$expectedHash = ([regex]::Match($sumLine, '^([0-9A-Fa-f]{64})')).Groups[1].Value
if ($expectedHash.Length -ne 64) {
  throw "SHA256SUMS.txt has an unreadable hash for $installer."
}
$actualHash = (Get-FileHash -LiteralPath (Join-Path $ReleaseDir $installer) -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash.ToUpperInvariant()) {
  throw "SHA256SUMS.txt says $expectedHash but $installer hashes to $actualHash. Regenerate the checksum."
}

$cleanPrefix = $Prefix.Trim('/')
$base = if ($BaseUrl) { $BaseUrl.TrimEnd('/') } else { $null }
if ($cleanPrefix) { $base = if ($base) { "$base/$cleanPrefix" } else { $null } }

if ($AccountId) { $env:CLOUDFLARE_ACCOUNT_ID = $AccountId }
$npx = Get-Command npx -ErrorAction Stop

Write-Output "Publishing Suura $version to r2://$Bucket/$cleanPrefix"
foreach ($file in $files) {
  $key = if ($cleanPrefix) { "$cleanPrefix/$($file.Key)" } else { $file.Key }
  Write-Output ("  {0} ({1:N0} bytes) -> {2}" -f $file.Name, $file.Length, $key)
}

if ($DryRun) {
  Write-Output 'Dry run: nothing uploaded.'
  if ($base) { Write-Output "Feed URL would be: $base" }
  return
}

foreach ($file in $files) {
  $key = if ($cleanPrefix) { "$cleanPrefix/$($file.Key)" } else { $file.Key }
  $objectPath = "$Bucket/$key"

  # --remote is explicit: without it Wrangler writes to its local simulator and
  # the feed stays empty while the command still reports success.
  $arguments = @(
    '--yes',
    'wrangler@4',
    'r2',
    'object',
    'put',
    $objectPath,
    '--file',
    $file.Path,
    '--content-type',
    $file.ContentType,
    '--cache-control',
    $file.CacheControl,
    '--remote'
  )

  & $npx.Source @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Wrangler failed to upload $($file.Name) (exit $LASTEXITCODE)."
  }
}

if (-not $base) {
  Write-Output 'Uploaded. Pass -BaseUrl to check the public files and print the feed URL.'
  return
}

Write-Output "Checking $base"
foreach ($file in $files) {
  $key = if ($cleanPrefix) { "$cleanPrefix/$($file.Key)" } else { $file.Key }
  $url = "$base/$key"
  try {
    $response = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 60
  } catch {
    throw "Uploaded, but $url is not reachable: $($_.Exception.Message). Check the bucket's public access."
  }
  if ($response.StatusCode -ne 200) {
    throw "Uploaded, but $url returned HTTP $($response.StatusCode)."
  }
  $remoteLength = $response.Headers['Content-Length'] | Select-Object -First 1
  if ($remoteLength -and [int64]$remoteLength -ne $file.Length) {
    throw "Uploaded, but $url is $remoteLength bytes instead of $($file.Length)."
  }
  Write-Output "  ok $($response.StatusCode) $url"
}

Write-Output ''
Write-Output "Feed URL: $base"
Write-Output 'Paste that into Settings -> About -> Feed folder, then press Check now.'
