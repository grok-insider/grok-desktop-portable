#!/usr/bin/env sh
# Copy workspace Ani.vrm into Portable same-origin assets for local dogfood.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
SRC="${ANI_VRM:-$ROOT/../Ani.vrm}"
DEST="$ROOT/apps/web/public/assets/aether/avatar.vrm"

if [ ! -f "$SRC" ]; then
  echo "use-local-ani: model not found: $SRC" >&2
  echo "Set ANI_VRM=/path/to/Ani.vrm" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
cp -f "$SRC" "$DEST"
# Ensure manifest allows loading this file.
cat >"$ROOT/apps/web/public/assets/aether/manifest.json" <<'EOF'
{
  "id": "portable-ani",
  "modelPath": "avatar.vrm",
  "displayName": "Ani",
  "distributionAllowed": true,
  "notes": "Local Ani.vrm via scripts/use-local-ani.sh — gitignored, not for redistrib."
}
EOF
echo "use-local-ani: wrote $DEST ($(wc -c <"$DEST") bytes)"
echo "Rebuild embed: pnpm build:web:dist && cargo build -p grok-bridge"
