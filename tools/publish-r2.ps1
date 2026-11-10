# Publishes Suura's release files to an R2 bucket that serves the update feed.
#
#   npx wrangler login                                   (once, or set CLOUDFLARE_API_TOKEN)
#   pwsh -File tools/publish-r2.ps1 -Bucket surra -BaseUrl https://pub-xxxx.r2.dev
#
# The bucket must be publicly readable through a custom domain or its r2.dev
# subdomain; a private bucket makes the feed useless even when the upload works.
# The app reads the folder configured in Settings -> About, so the base URL here
# is the same URL a user pastes there.
#
# Uploads the files electron-builder wrote for the current version, for whichever
# platform targets exist in the release folder:
#
#   Windows  the installer, its blockmap, latest.yml/beta.yml and the
#            Suura-Setup.exe alias.
#   Linux    the AppImage, its blockmap, latest-linux.yml/beta-linux.yml and the
#            Suura.AppImage alias.
#
# SHA256SUMS.txt is shared: it must have a line for every artefact being
# published. Versioned filenames are cached forever; channel files, checksums
# and the stable aliases are always revalidated so a new release is seen at once.
#
#   pwsh -File tools/publish-r2.ps1 -Bucket surra -BaseUrl https://... -DryRun
#   pwsh -File tools/publish-r2.ps1 -Platform linux
#
# The default, `-Platform auto`, publishes whatever is present. Passing a
# platform explicitly makes a missing artefact an error instead of a skip.

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
  # Which platform's files to publish. `auto` takes what the folder holds.
  [ValidateSet('auto', 'windows', 'linux')]
  [string]$Platform = 'auto',
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
$channel = if ($version -match '-') { 'beta' } else { 'latest' }

if (-not (Test-Path -LiteralPath $ReleaseDir)) {
  throw "Missing release folder: $ReleaseDir. Run 'npm run package:win' or 'npm run package:linux' first."
}

$immutable = 'public, max-age=31536000, immutable'
$revalidate = 'no-cache, max-age=0, must-revalidate'

function New-Entry([string]$Name, [string]$Key, [string]$ContentType, [string]$CacheControl) {
  [pscustomobject]@{
    Name = $Name
    Key = $Key
    ContentType = $ContentType
    CacheControl = $CacheControl
  }
}

# The stable alias is what the landing page and the README link to, so it is
# revalidated on every request: the object behind it changes each release.
$windowsArtifact = "Suura-$version-Setup.exe"
$windowsChannel = "$channel.yml"
$windows = [pscustomobject]@{
  Label = 'Windows'
  Artifact = $windowsArtifact
  ChannelFile = $windowsChannel
  Blockmap = "$windowsArtifact.blockmap"
  BuildScript = 'package:win'
  Files = @(
    (New-Entry $windowsArtifact $windowsArtifact 'application/octet-stream' $immutable)
    (New-Entry "$windowsArtifact.blockmap" "$windowsArtifact.blockmap" 'application/octet-stream' $immutable)
    (New-Entry $windowsChannel $windowsChannel 'text/yaml; charset=utf-8' $revalidate)
    (New-Entry $windowsArtifact 'Suura-Setup.exe' 'application/octet-stream' $revalidate)
  )
}

$linuxArtifact = "Suura-$version.AppImage"
$linuxChannel = "$channel-linux.yml"
$linux = [pscustomobject]@{
  Label = 'Linux'
  Artifact = $linuxArtifact
  ChannelFile = $linuxChannel
  Blockmap = "$linuxArtifact.blockmap"
  BuildScript = 'package:linux'
  Files = @(
    (New-Entry $linuxArtifact $linuxArtifact 'application/octet-stream' $immutable)
    (New-Entry "$linuxArtifact.blockmap" "$linuxArtifact.blockmap" 'application/octet-stream' $immutable)
    (New-Entry $linuxChannel $linuxChannel 'text/yaml; charset=utf-8' $revalidate)
    (New-Entry $linuxArtifact 'Suura.AppImage' 'application/octet-stream' $revalidate)
  )
}

$allSets = @($windows, $linux)
$selected = switch ($Platform) {
  'windows' { @($windows) }
  'linux' { @($linux) }
  default {
    @($allSets | Where-Object { Test-Path -LiteralPath (Join-Path $ReleaseDir $_.Artifact) })
  }
}

if ($selected.Count -eq 0) {
  throw "No release artefact for $version in $ReleaseDir. Run 'npm run package:win' or 'npm run package:linux' first."
}

$files = @()
foreach ($set in $selected) {
  $artifactPath = Join-Path $ReleaseDir $set.Artifact
  $channelPath = Join-Path $ReleaseDir $set.ChannelFile
  $blockmapPath = Join-Path $ReleaseDir $set.Blockmap
  if (-not (Test-Path -LiteralPath $artifactPath)) {
    throw "Missing $($set.Artifact) in $ReleaseDir. Run 'npm run $($set.BuildScript)' first."
  }
  if (-not (Test-Path -LiteralPath $channelPath)) {
    throw "Missing $($set.ChannelFile) in $ReleaseDir. Run 'npm run $($set.BuildScript)' first."
  }
  if (-not (Test-Path -LiteralPath $blockmapPath)) {
    throw "Missing $($set.Blockmap) in $ReleaseDir. Repackage rather than publishing a partial differential update."
  }

  # The channel file and the checksum must describe this exact artefact. A
  # mismatch here is the failure the updater would otherwise hit after download.
  $channelText = Get-Content -LiteralPath $channelPath -Raw
  if ($channelText -notmatch [regex]::Escape($set.Artifact)) {
    throw "$($set.ChannelFile) does not name $($set.Artifact). Repackage before publishing."
  }
  $sizeMatch = [regex]::Match($channelText, '(?m)^\s*size:\s*(\d+)\s*$')
  if ($sizeMatch.Success) {
    $declaredSize = [int64]$sizeMatch.Groups[1].Value
    $actualSize = (Get-Item -LiteralPath $artifactPath).Length
    if ($declaredSize -ne $actualSize) {
      throw "$($set.ChannelFile) says $declaredSize bytes but $($set.Artifact) is $actualSize bytes. Repackage before publishing."
    }
  }

  $sumPath = Join-Path $ReleaseDir 'SHA256SUMS.txt'
  if (-not (Test-Path -LiteralPath $sumPath)) {
    throw "Missing SHA256SUMS.txt in $ReleaseDir. Write a line for $($set.Artifact) first."
  }
  $sumLine = Get-Content -LiteralPath $sumPath |
    Where-Object { $_ -match [regex]::Escape($set.Artifact) } |
    Select-Object -First 1
  if (-not $sumLine) {
    throw "SHA256SUMS.txt has no line for $($set.Artifact)."
  }
  $expectedHash = ([regex]::Match($sumLine, '^([0-9A-Fa-f]{64})')).Groups[1].Value
  if ($expectedHash.Length -ne 64) {
    throw "SHA256SUMS.txt has an unreadable hash for $($set.Artifact)."
  }
  $actualHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash
  if ($actualHash -ne $expectedHash.ToUpperInvariant()) {
    throw "SHA256SUMS.txt says $expectedHash but $($set.Artifact) hashes to $actualHash. Regenerate the checksum."
  }

  $files += $set.Files
}

# One checksum file for the folder, whichever platforms were built.
$files += New-Entry 'SHA256SUMS.txt' 'SHA256SUMS.txt' 'text/plain; charset=utf-8' $revalidate

foreach ($file in $files) {
  $path = Join-Path $ReleaseDir $file.Name
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing $($file.Name) in $ReleaseDir."
  }
  $file | Add-Member -NotePropertyName Path -NotePropertyValue $path
  $file | Add-Member -NotePropertyName Length -NotePropertyValue (Get-Item -LiteralPath $path).Length
}

$cleanPrefix = $Prefix.Trim('/')
$base = if ($BaseUrl) { $BaseUrl.TrimEnd('/') } else { $null }
if ($cleanPrefix) { $base = if ($base) { "$base/$cleanPrefix" } else { $null } }

if ($AccountId) { $env:CLOUDFLARE_ACCOUNT_ID = $AccountId }
$npx = Get-Command npx -ErrorAction Stop

$labels = ($selected | ForEach-Object { $_.Label }) -join ' + '
Write-Output "Publishing Suura $version ($labels) to r2://$Bucket/$cleanPrefix"
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
