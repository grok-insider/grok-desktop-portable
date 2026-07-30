# Install grok-bridge from GitHub Releases (Grok Desktop Portable).
# Usage (PowerShell):
#   irm https://desktop.grok.me/install.ps1 | iex
#   $env:VERSION='v0.1.0-beta.1'; irm https://desktop.grok.me/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$Repo = if ($env:GROK_BRIDGE_REPO) { $env:GROK_BRIDGE_REPO } else { 'grok-insider/grok-desktop-portable' }
$Version = if ($env:VERSION) { $env:VERSION } else { 'latest' }
$InstallDir = if ($env:GROK_BRIDGE_INSTALL_DIR) {
  $env:GROK_BRIDGE_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA 'grok-bridge\bin'
}
$BinName = 'grok-bridge.exe'
$Asset = 'grok-bridge-windows-x64.exe'

if ($Version -eq 'latest') {
  $Base = "https://github.com/$Repo/releases/latest/download"
} else {
  $Base = "https://github.com/$Repo/releases/download/$Version"
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
