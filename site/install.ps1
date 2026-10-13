# Public installer for the desktop.grok.me local host.
# Served at: https://desktop.grok.me/install.ps1
#
# The host is `spanreed agent` (formerly the standalone grok-bridge). This
# installs spanreed.exe into %LOCALAPPDATA%\spanreed\bin, plus a
# grok-bridge.exe copy that runs `spanreed agent` so existing commands keep
# working.
#
# This script does NOT read install policy from environment variables.
#
# Usage:
#   irm https://desktop.grok.me/install.ps1 | iex
#
# For forks / custom paths / pinned tags, clone the repo and use
# install/install.ps1.
$ErrorActionPreference = 'Stop'

# --- fixed product constants (do not read env for these) ---
$Repo = 'grok-insider/spanreed'
$InstallDir = Join-Path $env:LOCALAPPDATA 'spanreed\bin'
$BinName = 'spanreed.exe'
$LegacyName = 'grok-bridge.exe'
$Target = 'x86_64-pc-windows-msvc'

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
  $headers = @{ Accept = 'application/vnd.github+json' }
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers
  if ($release.draft -or $release.prerelease -or $release.tag_name -cnotmatch '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw 'Latest release did not provide a stable version tag; retry later'
  }
  return $release.tag_name
}

function Assert-InstallDestination {
  param([string]$Destination)
  $DestinationItem = Get-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
  if ($DestinationItem -and ($DestinationItem.PSIsContainer -or ($DestinationItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint))) {
    throw 'Install destination must be a regular file or absent'
  }
}

function Install-Binary {
  param([string]$Source, [string]$Destination)
  $SourceItem = Get-Item -LiteralPath $Source -Force
  if ($SourceItem.PSIsContainer -or ($SourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'Install source must be a regular file'
  }
  Assert-InstallDestination -Destination $Destination
  $Staged = Join-Path (Split-Path -Parent $Destination) ('.spanreed-install-' + [guid]::NewGuid().ToString('n'))
  $Backup = "$Staged.previous"
  try {
    [System.IO.File]::Copy($Source, $Staged, $false)
    if ((Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $Staged -Algorithm SHA256).Hash) {
      throw 'Staged binary differs from the verified source'
    }
    Assert-InstallDestination -Destination $Destination
    if (Test-Path -LiteralPath $Destination) {
      [System.IO.File]::Replace($Staged, $Destination, $Backup)
    } else {
      [System.IO.File]::Move($Staged, $Destination)
    }
    Remove-Item -LiteralPath $Backup -Force -ErrorAction SilentlyContinue
  } catch {
    if (-not (Test-Path -LiteralPath $Destination) -and (Test-Path -LiteralPath $Backup)) {
      [System.IO.File]::Move($Backup, $Destination)
    }
    throw
  } finally {
    Remove-Item -LiteralPath $Staged -Force -ErrorAction SilentlyContinue
  }
}

$Version = Resolve-Tag
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
  $fields = (Get-Content -LiteralPath $SumPath -Raw).Trim() -split '\s+'
  if ($fields.Count -ne 2 -or $fields[0] -notmatch '^[a-fA-F0-9]{64}$' -or $fields[1] -cne $Asset) { throw "$Asset.sha256 does not describe $Asset" }
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
  Assert-InstallDestination -Destination $Dest
  Assert-InstallDestination -Destination (Join-Path $InstallDir $LegacyName)
  Install-Binary -Source (Join-Path $Unpacked $BinName) -Destination $Dest
  Install-Binary -Source $Dest -Destination (Join-Path $InstallDir $LegacyName)
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
  Write-Host '  2. Connect this computer and your device to Tailscale; enable MagicDNS and HTTPS, and allow device access to TCP 443.'
  Write-Host '  3. Open a new shell so User PATH includes this install dir, then: spanreed remote doctor'
  Write-Host '  4. spanreed remote private-serve https://HOST   # use this computer''s Tailscale HTTPS hostname; leave running'
  Write-Host '  5. In another terminal, check "tailscale serve status" before assigning its HTTPS root:'
  Write-Host '     tailscale serve --bg --https=443 http://127.0.0.1:PORT   # use the port printed by Spanreed'
  Write-Host '  6. spanreed remote private-pair https://HOST   # same hostname as step 4'
  Write-Host '  7. Open the one-use link on your device; it opens https://desktop.grok.me. Keep the computer running.'
  Write-Host ''
  Write-Host 'Windows SmartScreen may warn; use More info → Run anyway after verifying the checksum.'
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
