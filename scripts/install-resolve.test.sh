#!/usr/bin/env sh
# Drive the real site/install.sh resolution path (--dry-run).
# Proves public installer ignores env overrides and does not use /releases/latest.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
INSTALL_SH="$ROOT/site/install.sh"
SCRATCH="${INSTALL_TEST_SCRATCH:-$(mktemp -d)}"
mkdir -p "$SCRATCH"

if grep -E 'releases/latest/download' "$INSTALL_SH" "$ROOT/site/install.ps1" 2>/dev/null; then
  echo "install scripts must not hardcode releases/latest/download" >&2
  exit 1
fi

for forbidden in \
  'GROK_BRIDGE_REPO' \
  'GROK_BRIDGE_FALLBACK_TAG' \
  'GROK_BRIDGE_INSTALL_DIR' \
  'INSTALL_DRY_RUN' \
  'VERSION:-' \
  '${VERSION:-' \
  'env:VERSION' \
  'env:GROK_BRIDGE' \
  'env:INSTALL_DRY_RUN'
do
  if grep -F "$forbidden" "$INSTALL_SH" "$ROOT/site/install.ps1" 2>/dev/null; then
    echo "public install scripts must not reference override knob: $forbidden" >&2
    exit 1
  fi
done

grep -q 'grok-insider/grok-desktop-portable' "$INSTALL_SH"
grep -q 'api.github.com/repos/' "$INSTALL_SH"
grep -q 'Invoke-RestMethod' "$ROOT/site/install.ps1"
grep -q -- '--dry-run' "$INSTALL_SH"

# Env poisoning must not change resolution.
out=$(
  env -i PATH="$PATH" HOME="$HOME" \
    VERSION=v0.0.0-evil \
    GROK_BRIDGE_REPO=evil/evil \
    GROK_BRIDGE_FALLBACK_TAG=v0.0.0-evil \
    GROK_BRIDGE_INSTALL_DIR=/tmp/evil-bin \
    INSTALL_DRY_RUN=1 \
    sh "$INSTALL_SH" --dry-run 2>"$SCRATCH/install-resolve.err" | tee "$SCRATCH/install-resolve.out"
)
echo "$out" | grep -q '^RESOLVED_TAG=v'
echo "$out" | grep -q '^DOWNLOAD_URL=https://github.com/grok-insider/grok-desktop-portable/releases/download/'
echo "$out" | grep -q '^DRY_RUN_OK$'
if echo "$out" | grep -q 'evil'; then
  echo "public installer honored poisoned env" >&2
  exit 1
fi
if echo "$out" | grep -q '/releases/latest/download'; then
  echo "resolved URL still uses /releases/latest/download" >&2
  exit 1
fi

# Operator clone script still allows install dir + version for tests.
op="$ROOT/install/install.sh"
install_dir="$SCRATCH/install-bin"
rm -rf "$install_dir"
mkdir -p "$install_dir"
GROK_BRIDGE_INSTALL_DIR="$install_dir" VERSION=latest sh "$op" 2>&1 | tee "$SCRATCH/install-full.log"
test -x "$install_dir/grok-bridge"
if [ -x "$ROOT/scripts/assert-spa-embedded.sh" ]; then
  sh "$ROOT/scripts/assert-spa-embedded.sh" "$install_dir/grok-bridge"
fi

echo "install-resolve.test.sh: ok"
