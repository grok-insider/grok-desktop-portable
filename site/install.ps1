# Public installer for the desktop.grok.me local host.
# Served at: https://desktop.grok.me/install.ps1
#
# The host is `spanreed agent` (formerly the standalone grok-bridge). This
# installs spanreed.exe into %LOCALAPPDATA%\spanreed\bin, plus a
# grok-bridge.exe copy that runs `spanreed agent` so existing commands keep
# working.
#
# This script does NOT read install policy from environment variables.
# It always installs the newest release of the official repo (including
# prereleases).
#
# Usage:
#   irm https://desktop.grok.me/install.ps1 | iex
#
# For forks / custom paths / pinned tags, clone the repo and use
# install/install.ps1.
$ErrorActionPreference = 'Stop'

# --- fixed product constants (do not read env for these) ---
$Repo = 'grok-insider/spanreed'
# Used only if the GitHub API is unreachable: the first release with `spanreed agent`.
$FallbackTag = 'v0.7.0'
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
  Write-Host '  2. Open a new shell so User PATH includes this install dir, then: spanreed agent doctor'
  Write-Host '  3. spanreed agent serve   # leave running'
  Write-Host '  4. spanreed agent open    # open the URL in Chrome, Firefox 84+, or Edge (not Safari)'
  Write-Host ''
  Write-Host 'Windows SmartScreen may warn; use More info → Run anyway after verifying the checksum.'
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
