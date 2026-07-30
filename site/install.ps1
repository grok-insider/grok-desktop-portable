# Install grok-bridge from GitHub Releases (Grok Desktop Portable).
# Usage (PowerShell):
#   irm https://desktop.grok.me/install.ps1 | iex
#   $env:VERSION='v0.1.0-beta.1'; irm https://desktop.grok.me/install.ps1 | iex
#
# Default VERSION=latest resolves via the GitHub API including prereleases.
# GitHub's /releases/latest URL skips prereleases and 404s when only betas exist.
$ErrorActionPreference = 'Stop'

$Repo = if ($env:GROK_BRIDGE_REPO) { $env:GROK_BRIDGE_REPO } else { 'grok-insider/grok-desktop-portable' }
$Version = if ($env:VERSION) { $env:VERSION } else { 'latest' }
$FallbackTag = if ($env:GROK_BRIDGE_FALLBACK_TAG) { $env:GROK_BRIDGE_FALLBACK_TAG } else { 'v0.1.0-beta.1' }
$InstallDir = if ($env:GROK_BRIDGE_INSTALL_DIR) {
  $env:GROK_BRIDGE_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA 'grok-bridge\bin'
}
$BinName = 'grok-bridge.exe'
$Asset = 'grok-bridge-windows-x64.exe'

function Resolve-Tag([string]$Want) {
  if ($Want -ne 'latest') { return $Want }
  try {
    $headers = @{ Accept = 'application/vnd.github+json' }
    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=20" -Headers $headers
    if ($releases -and $releases.Count -gt 0) {
      return $releases[0].tag_name
    }
  } catch {
    Write-Warning "Could not resolve latest release via API: $_"
  }
  Write-Warning "Using fallback tag $FallbackTag"
  return $FallbackTag
}

$Version = Resolve-Tag $Version
$Base = "https://github.com/$Repo/releases/download/$Version"

if ($env:INSTALL_DRY_RUN -eq '1') {
  Write-Host "RESOLVED_TAG=$Version"
  Write-Host "DOWNLOAD_URL=$Base/$Asset"
  Write-Host "CHECKSUMS_URL=$Base/checksums.txt"
  # HEAD-style check
  Invoke-WebRequest -Uri "$Base/$Asset" -Method Head -UseBasicParsing | Out-Null
  Invoke-WebRequest -Uri "$Base/checksums.txt" -Method Head -UseBasicParsing | Out-Null
  Write-Host 'DRY_RUN_OK'
  return
}

$Tmp = New-Item -ItemType Directory -Path ([System.IO.Path]::GetTempPath()) -Name ("grok-bridge-" + [guid]::NewGuid().ToString('n'))
try {
  $BinPath = Join-Path $Tmp.FullName $Asset
  $SumPath = Join-Path $Tmp.FullName 'checksums.txt'
  Write-Host "Downloading $Asset ($Version)…"
  Invoke-WebRequest -Uri "$Base/$Asset" -OutFile $BinPath -UseBasicParsing
  try {
    Invoke-WebRequest -Uri "$Base/checksums.txt" -OutFile $SumPath -UseBasicParsing
    $line = Select-String -Path $SumPath -Pattern ([regex]::Escape($Asset)) | Select-Object -First 1
    if (-not $line) { throw "$Asset not listed in checksums.txt" }
    $expected = ($line.Line -split '\s+')[0].Trim().ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -Path $BinPath).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "checksum mismatch for $Asset`n  expected: $expected`n  actual:   $actual"
    }
    Write-Host 'Checksum OK'
  } catch {
    Write-Warning "Checksum verification skipped or failed: $_"
  }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $Dest = Join-Path $InstallDir $BinName
  Copy-Item -Force -Path $BinPath -Destination $Dest
  Write-Host "Installed $Dest"

  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$UserPath;$InstallDir", 'User')
    $env:Path = "$env:Path;$InstallDir"
    Write-Host "Added $InstallDir to user PATH (new shells pick it up)."
  }

  Write-Host ''
  Write-Host 'Next:'
  Write-Host '  1. Install and authenticate the Grok Build CLI (grok).'
  Write-Host '  2. grok-bridge doctor'
  Write-Host '  3. grok-bridge serve'
  Write-Host '  4. grok-bridge open   # open the URL in Chrome/Firefox (not Safari)'
  Write-Host ''
  Write-Host 'Unsigned FOSS build — prefer verifying checksums and source tags.'
  Write-Host 'Windows SmartScreen may warn; use More info → Run anyway after verifying.'
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
