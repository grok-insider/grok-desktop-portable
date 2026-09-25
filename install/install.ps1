# Operator / clone installer for the desktop.grok.me local host (optional env
# overrides). Prefer https://desktop.grok.me/install.ps1 for the locked public path.
#
# The host is `spanreed agent`. This installs spanreed.exe plus a
# grok-bridge.exe copy that runs `spanreed agent`.
#
# Usage:
#   .\install\install.ps1
#   $env:VERSION = 'v0.7.0'; $env:SPANREED_INSTALL_DIR = 'C:\tools'; .\install\install.ps1
#   $env:INSTALL_DRY_RUN = '1'; .\install\install.ps1
$ErrorActionPreference = 'Stop'
$Repo = if ($env:SPANREED_REPO) { $env:SPANREED_REPO } else { 'grok-insider/spanreed' }
$Version = if ($env:VERSION) { $env:VERSION } else { 'latest' }
$FallbackTag = if ($env:SPANREED_FALLBACK_TAG) { $env:SPANREED_FALLBACK_TAG } else { 'v0.7.0' }
$InstallDir = if ($env:SPANREED_INSTALL_DIR) { $env:SPANREED_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'spanreed\bin' }
$BinName = 'spanreed.exe'
$LegacyName = 'grok-bridge.exe'
$Target = 'x86_64-pc-windows-msvc'

$DryRun = $env:INSTALL_DRY_RUN -eq '1'
foreach ($a in $args) {
  if ($a -eq '-DryRun' -or $a -eq '--dry-run') { $DryRun = $true }
  else { throw "Unknown argument: $a (accepts only -DryRun)" }
}

function Resolve-Tag([string]$Want) {
  if ($Want -ne 'latest') { return $Want }
  try {
    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=20" -Headers @{ Accept = 'application/vnd.github+json' }
    if ($releases -and $releases.Count -gt 0) { return $releases[0].tag_name }
  } catch {
    Write-Warning "Could not resolve latest release via API: $_"
  }
  Write-Warning "Using fallback tag $FallbackTag"
  return $FallbackTag
}

$Version = Resolve-Tag $Version
$Asset = "spanreed-$($Version.TrimStart('v'))-$Target.zip"
$Base = "https://github.com/$Repo/releases/download/$Version"

if ($DryRun) {
  Write-Host "RESOLVED_TAG=$Version"
  Write-Host "TARGET=$Target"
  Write-Host "DOWNLOAD_URL=$Base/$Asset"
  Write-Host "CHECKSUM_URL=$Base/$Asset.sha256"
  Write-Host "INSTALL_DIR=$InstallDir"
  Invoke-WebRequest -Uri "$Base/$Asset" -Method Head -UseBasicParsing | Out-Null
  Invoke-WebRequest -Uri "$Base/$Asset.sha256" -Method Head -UseBasicParsing | Out-Null
  Write-Host 'DRY_RUN_OK'
  return
}

$Tmp = New-Item -ItemType Directory -Path ([System.IO.Path]::GetTempPath()) -Name ("spanreed-" + [guid]::NewGuid().ToString('n'))
try {
  $ZipPath = Join-Path $Tmp.FullName $Asset
  $SumPath = "$ZipPath.sha256"
  Write-Host "Downloading $Asset ($Version) from $Repo…"
  Invoke-WebRequest -Uri "$Base/$Asset" -OutFile $ZipPath -UseBasicParsing
  Invoke-WebRequest -Uri "$Base/$Asset.sha256" -OutFile $SumPath -UseBasicParsing
  $fields = (Get-Content -Path $SumPath -TotalCount 1) -split '\s+'
  if ($fields.Count -lt 2 -or $fields[1] -ne $Asset) { throw "$Asset.sha256 does not describe $Asset" }
  $expected = $fields[0].Trim().ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 -Path $ZipPath).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    throw "checksum mismatch for $Asset`n  expected: $expected`n  actual:   $actual"
  }
  Write-Host 'Checksum OK'

  $Unpacked = Join-Path $Tmp.FullName 'unpacked'
  Expand-Archive -Path $ZipPath -DestinationPath $Unpacked
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $Dest = Join-Path $InstallDir $BinName
  Copy-Item -Force -Path (Join-Path $Unpacked $BinName) -Destination $Dest
  Copy-Item -Force -Path $Dest -Destination (Join-Path $InstallDir $LegacyName)
  Write-Host "Installed $Dest (and $LegacyName, which runs spanreed agent)"

  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$UserPath;$InstallDir", 'User')
    $env:Path = "$env:Path;$InstallDir"
    Write-Host "Added $InstallDir to user PATH (new shells pick it up)."
  }

  Write-Host ''
  Write-Host 'Next:'
  Write-Host '  1. Install and authenticate the Grok Build CLI (grok) separately.'
  Write-Host '  2. spanreed agent doctor'
  Write-Host '  3. spanreed agent serve   # leave running'
  Write-Host '  4. spanreed agent open    # open the URL in Chrome, Firefox 84+, or Edge (not Safari)'
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
