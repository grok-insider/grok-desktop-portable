# Public installer for grok-bridge (Grok Desktop Portable).
# Served at: https://desktop.grok.me/install.ps1
#
# This script does NOT read install policy from environment variables.
# It always installs the newest release of the official repo (including
# prereleases) into %LOCALAPPDATA%\grok-bridge\bin.
#
# Usage:
#   irm https://desktop.grok.me/install.ps1 | iex
#
# For forks / custom paths / pinned tags, clone the repo and use
# install/install.ps1.
$ErrorActionPreference = 'Stop'

# --- fixed product constants (do not read env for these) ---
$Repo = 'grok-insider/grok-desktop-portable'
$FallbackTag = 'v0.1.0'
$InstallDir = Join-Path $env:LOCALAPPDATA 'grok-bridge\bin'
$BinName = 'grok-bridge.exe'
$Asset = 'grok-bridge-windows-x64.exe'

$DryRun = $false
foreach ($a in $args) {
  if ($a -eq '-DryRun' -or $a -eq '--dry-run') { $DryRun = $true }
  elseif ($a -eq '-h' -or $a -eq '--help' -or $a -eq '-Help') {
    Write-Host 'Public installer: irm https://desktop.grok.me/install.ps1 | iex'
    Write-Host 'Only optional flag when running the file: -DryRun'
    return
  }
  else {
    throw "Unknown argument: $a (public installer accepts only -DryRun)"
  }
}

function Resolve-Tag {
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

$Version = Resolve-Tag
$Base = "https://github.com/$Repo/releases/download/$Version"

if ($DryRun) {
  Write-Host "RESOLVED_TAG=$Version"
  Write-Host "DOWNLOAD_URL=$Base/$Asset"
  Write-Host "CHECKSUMS_URL=$Base/checksums.txt"
  Write-Host "INSTALL_DIR=$InstallDir"
  Invoke-WebRequest -Uri "$Base/$Asset" -Method Head -UseBasicParsing | Out-Null
  Invoke-WebRequest -Uri "$Base/checksums.txt" -Method Head -UseBasicParsing | Out-Null
  Write-Host 'DRY_RUN_OK'
  return
}

$Tmp = New-Item -ItemType Directory -Path ([System.IO.Path]::GetTempPath()) -Name ("grok-bridge-" + [guid]::NewGuid().ToString('n'))
try {
  $BinPath = Join-Path $Tmp.FullName $Asset
  $SumPath = Join-Path $Tmp.FullName 'checksums.txt'
  Write-Host "Downloading $Asset ($Version) from $Repo…"
  Invoke-WebRequest -Uri "$Base/$Asset" -OutFile $BinPath -UseBasicParsing
  Invoke-WebRequest -Uri "$Base/checksums.txt" -OutFile $SumPath -UseBasicParsing
  $line = Select-String -Path $SumPath -Pattern ([regex]::Escape($Asset)) | Select-Object -First 1
  if (-not $line) { throw "$Asset not listed in checksums.txt" }
  $expected = ($line.Line -split '\s+')[0].Trim().ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 -Path $BinPath).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    throw "checksum mismatch for $Asset`n  expected: $expected`n  actual:   $actual"
  }
  Write-Host 'Checksum OK'

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
  Write-Host '  1. Install and authenticate the Grok Build CLI (grok) separately — version ≥ 0.2.115.'
  Write-Host '     Portable does not install grok; PATH for grok comes from that CLI installer.'
  Write-Host '  2. Open a new shell so User PATH includes this install dir, then: grok-bridge doctor'
  Write-Host '  3. grok-bridge serve   # leave running (no autostart in this beta)'
  Write-Host '  4. grok-bridge open   # open the URL in Chrome, Firefox 84+, or Edge (not Safari)'
  Write-Host ''
  Write-Host 'Assets: grok-bridge-linux-x64, grok-bridge-darwin-arm64, grok-bridge-windows-x64.exe'
  Write-Host 'Unsigned FOSS build — prefer verifying checksums and source tags.'
  Write-Host 'Windows SmartScreen may warn; use More info → Run anyway after verifying.'
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
