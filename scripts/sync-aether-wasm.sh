#!/usr/bin/env sh
# Copy built Aether wasm-bindgen package into Portable SPA public assets.
# Usage:
#   ./scripts/sync-aether-wasm.sh
#   AETHER_ROOT=/path/to/aether ./scripts/sync-aether-wasm.sh
#   SYNC_AETHER_BUILD=1 ./scripts/sync-aether-wasm.sh   # run build-wasm.sh first
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
AETHER_ROOT="${AETHER_ROOT:-$ROOT/../aether}"
DEST="$ROOT/apps/web/public/assets/aether"
RUNTIME="$DEST/runtime"
PKG="$AETHER_ROOT/crates/aether-wasm/pkg"

if [ ! -d "$AETHER_ROOT" ]; then
  echo "sync-aether-wasm: Aether root not found: $AETHER_ROOT" >&2
  echo "Set AETHER_ROOT to the aether checkout." >&2
  exit 1
fi

if [ "${SYNC_AETHER_BUILD:-0}" = "1" ]; then
  if [ -x "$AETHER_ROOT/scripts/build-wasm.sh" ]; then
    (cd "$AETHER_ROOT" && bash scripts/build-wasm.sh)
  else
    echo "sync-aether-wasm: build-wasm.sh missing under $AETHER_ROOT" >&2
    exit 1
  fi
fi

if [ ! -f "$PKG/aether.js" ] || [ ! -f "$PKG/aether_bg.wasm" ]; then
  echo "sync-aether-wasm: missing $PKG/aether.js or aether_bg.wasm" >&2
  echo "Build first: (cd \"\$AETHER_ROOT\" && bash scripts/build-wasm.sh)" >&2
  exit 1
fi

mkdir -p "$RUNTIME"
cp -f "$PKG/aether.js" "$RUNTIME/aether.js"
cp -f "$PKG/aether_bg.wasm" "$RUNTIME/aether_bg.wasm"
# Types optional for runtime; keep if present for local reference.
if [ -f "$PKG/aether.d.ts" ]; then
  cp -f "$PKG/aether.d.ts" "$RUNTIME/aether.d.ts"
fi

VERSION="unknown"
if command -v git >/dev/null 2>&1 && [ -d "$AETHER_ROOT/.git" ]; then
  VERSION="$(git -C "$AETHER_ROOT" describe --tags --always --dirty 2>/dev/null || true)"
  if [ -z "$VERSION" ]; then
    VERSION="$(git -C "$AETHER_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  fi
fi
printf '%s\n' "$VERSION" >"$DEST/VERSION"

# Ensure license/manifest placeholders exist without clobbering.
if [ ! -f "$DEST/LICENSES.md" ]; then
  cat >"$DEST/LICENSES.md" <<'EOF'
# Aether assets (Portable)

## Runtime (WASM)

Aether source is dual-licensed MIT OR Apache-2.0. Vendored glue and
`aether_bg.wasm` are built from the Aether repository; see the pinned
`VERSION` file in this directory.

## Avatar model

When `avatar.vrm` is present, document its license and source here before
shipping. Until a redistributable model is cleared, Portable uses the
in-module minimal fixture (`loadFixture`) and must not claim a third-party
character identity.
EOF
fi

if [ ! -f "$DEST/manifest.json" ]; then
  cat >"$DEST/manifest.json" <<'EOF'
{
  "id": "portable-default",
  "modelPath": "avatar.vrm",
  "distributionAllowed": false,
  "notes": "Set distributionAllowed true and add LICENSES entry when a redistributable VRM is committed."
}
EOF
fi

echo "sync-aether-wasm: wrote $RUNTIME (VERSION=$VERSION)"
ls -la "$RUNTIME"
