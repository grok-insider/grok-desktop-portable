#!/usr/bin/env sh
# Drive the real site/install.sh resolution path (INSTALL_DRY_RUN=1).
# Proves VERSION=latest does not use /releases/latest (prerelease 404) and
# that the resolved download URLs return success for a published asset.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
INSTALL_SH="$ROOT/site/install.sh"
SCRATCH="${INSTALL_TEST_SCRATCH:-/tmp/grok-goal-505a811f98f9/implementer}"
mkdir -p "$SCRATCH"

# Static: scripts must not use the prerelease-blind latest *download* URL.
if grep -E 'releases/latest/download' "$INSTALL_SH" "$ROOT/site/install.ps1" 2>/dev/null; then
  echo "install scripts must not hardcode releases/latest/download" >&2
  exit 1
fi
# Must resolve via API (includes prereleases).
grep -q 'api.github.com/repos/' "$INSTALL_SH"
grep -q 'Invoke-RestMethod' "$ROOT/site/install.ps1"

# Live: dry-run the real install.sh (network).
out=$(INSTALL_DRY_RUN=1 VERSION=latest sh "$INSTALL_SH" 2>"$SCRATCH/install-resolve.err" | tee "$SCRATCH/install-resolve.out")
echo "$out" | grep -q '^RESOLVED_TAG=v'
echo "$out" | grep -q '^DOWNLOAD_URL=https://github.com/grok-insider/grok-desktop-portable/releases/download/'
echo "$out" | grep -q '^DRY_RUN_OK$'
# Must not mention /releases/latest/download
if echo "$out" | grep -q '/releases/latest/download'; then
  echo "resolved URL still uses /releases/latest/download" >&2
  exit 1
fi

# Explicit pin still works.
out2=$(INSTALL_DRY_RUN=1 VERSION=v0.1.0-beta.1 sh "$INSTALL_SH" 2>>"$SCRATCH/install-resolve.err" | tee -a "$SCRATCH/install-resolve.out")
echo "$out2" | grep -q 'RESOLVED_TAG=v0.1.0-beta.1'
echo "$out2" | grep -q 'DRY_RUN_OK'

# Full install into scratch dir (real download + checksum + install path).
install_dir="$SCRATCH/install-bin"
rm -rf "$install_dir"
mkdir -p "$install_dir"
GROK_BRIDGE_INSTALL_DIR="$install_dir" VERSION=latest sh "$INSTALL_SH" 2>&1 | tee "$SCRATCH/install-full.log"
test -x "$install_dir/grok-bridge"
# Binary has SPA
sh "$ROOT/scripts/assert-spa-embedded.sh" "$install_dir/grok-bridge"
# doctor is informative
STATE="$SCRATCH/install-state"
rm -rf "$STATE" && mkdir -m 700 "$STATE"
GROK_BRIDGE_STATE_DIR="$STATE" "$install_dir/grok-bridge" doctor 2>&1 | tee "$SCRATCH/install-doctor.log"
grep -q 'grok cli' "$SCRATCH/install-doctor.log"

echo "install-resolve.test.sh: ok"
