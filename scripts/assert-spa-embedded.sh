#!/usr/bin/env sh
# Fail closed if a grok-bridge binary lacks the embedded Work SPA.
# Usage: scripts/assert-spa-embedded.sh path/to/grok-bridge
set -eu

BIN="${1:-}"
if [ -z "$BIN" ] || [ ! -f "$BIN" ]; then
  echo "assert-spa-embedded: binary not found: ${BIN:-<empty>}" >&2
  exit 1
fi

SIZE=$(wc -c <"$BIN" | tr -d ' ')
# Release with SPA is typically ~5–10MB after strip; placeholder is much smaller.
# Darwin arm64 release can land just under 5MB after strip — keep the floor
# low enough that a real embed passes, high enough that empty embeds fail.
MIN_SIZE="${GROK_BRIDGE_MIN_BYTES:-3500000}"

markers=0
if command -v strings >/dev/null 2>&1; then
  # strings can fail on some toolchains (flush errors); never treat that as OK alone.
  if strings "$BIN" 2>/dev/null | grep -E -q 'index\.html|/assets/|ibm-plex|text/html; charset=utf-8'; then
    markers=1
  fi
fi

if [ "$SIZE" -lt "$MIN_SIZE" ]; then
  echo "assert-spa-embedded: binary too small to contain SPA ($SIZE < $MIN_SIZE): $BIN" >&2
  exit 1
fi

if [ "$markers" -ne 1 ]; then
  # Size alone is a weak signal; require markers when strings works.
  if command -v strings >/dev/null 2>&1; then
    echo "assert-spa-embedded: SPA markers not found in $BIN (size=$SIZE)" >&2
    exit 1
  fi
fi

echo "assert-spa-embedded: ok size=$SIZE markers=$markers path=$BIN"
