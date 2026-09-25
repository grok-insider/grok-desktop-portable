# Operator / clone installer (optional env overrides).
# Prefer https://desktop.grok.me/install.ps1 for the locked public path.
$ErrorActionPreference = 'Stop'
$Repo = if ($env:SPANREED_REPO) { $env:SPANREED_REPO } else { 'grok-insider/spanreed' }
$Version = if ($env:VERSION) { $env:VERSION } else { 'latest' }
$FallbackTag = if ($env:SPANREED_FALLBACK_TAG) { $env:SPANREED_FALLBACK_TAG } else { 'v0.7.0' }
$InstallDir = if ($env:SPANREED_INSTALL_DIR) { $env:SPANREED_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'spanreed\bin' }
$Target = 'x86_64-pc-windows-msvc'
function Resolve-Tag([string]$Want) {
  if ($Want -ne 'latest') { return $Want }
  try {
    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=20" -Headers @{ Accept = 'application/vnd.github+json' }
    if ($releases -and $releases.Count -gt 0) { return $releases[0].tag_name }
  } catch { Write-Warning "API: $_" }
  return $FallbackTag
}
$Version = Resolve-Tag $Version
$Asset = "spanreed-$($Version.TrimStart('v'))-$Target.zip"
$Base = "https://github.com/$Repo/releases/download/$Version"
if ($env:INSTALL_DRY_RUN -eq '1') {
  Write-Host "RESOLVED_TAG=$Version"; Write-Host "TARGET=$Target"; Write-Host "DOWNLOAD_URL=$Base/$Asset"; Write-Host 'DRY_RUN_OK'; return
}
Write-Host "Clone installer would download $Asset ($Version) to $InstallDir"
