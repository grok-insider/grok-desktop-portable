# Operator / clone installer (optional env overrides).
# Prefer https://desktop.grok.me/install.ps1 for the locked public path.
$ErrorActionPreference = 'Stop'
$Repo = if ($env:GROK_BRIDGE_REPO) { $env:GROK_BRIDGE_REPO } else { 'grok-insider/grok-desktop-portable' }
$Version = if ($env:VERSION) { $env:VERSION } else { 'latest' }
$FallbackTag = if ($env:GROK_BRIDGE_FALLBACK_TAG) { $env:GROK_BRIDGE_FALLBACK_TAG } else { 'v0.1.0' }
$InstallDir = if ($env:GROK_BRIDGE_INSTALL_DIR) { $env:GROK_BRIDGE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'grok-bridge\bin' }
$BinName = 'grok-bridge.exe'
$Asset = 'grok-bridge-windows-x64.exe'
function Resolve-Tag([string]$Want) {
  if ($Want -ne 'latest') { return $Want }
  try {
    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=20" -Headers @{ Accept = 'application/vnd.github+json' }
    if ($releases -and $releases.Count -gt 0) { return $releases[0].tag_name }
  } catch { Write-Warning "API: $_" }
  return $FallbackTag
}
$Version = Resolve-Tag $Version
$Base = "https://github.com/$Repo/releases/download/$Version"
if ($env:INSTALL_DRY_RUN -eq '1') {
  Write-Host "RESOLVED_TAG=$Version"; Write-Host "DOWNLOAD_URL=$Base/$Asset"; Write-Host 'DRY_RUN_OK'; return
}
Write-Host "Clone installer would download $Asset ($Version) to $InstallDir"
