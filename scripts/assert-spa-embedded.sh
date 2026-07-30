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
# Unstripped debug with SPA is ~100MB; release with SPA is typically >> 5MB.
# Placeholder host without SPA is much smaller.
MIN_SIZE="${GROK_BRIDGE_MIN_BYTES:-5000000}"

found=0
if command -v strings >/dev/null 2>&1; then
  if strings "$BIN" | grep -E -q 'index\.html|/assets/|ibm-plex|text/html; charset=utf-8'; then
    found=1
  fi
else
  # Windows CI may lack strings; fall back to size only when marker scan unavailable.
  if [ "$SIZE" -ge "$MIN_SIZE" ]; then
    found=1
  fi
fi

if [ "$found" -ne 1 ]; then
  echo "assert-spa-embedded: SPA markers not found in $BIN (size=$SIZE)" >&2
  exit 1
fi

if [ "$SIZE" -lt "$MIN_SIZE" ]; then
  echo "assert-spa-embedded: binary too small to contain SPA ($SIZE < $MIN_SIZE): $BIN" >&2
  exit 1
fi

echo "assert-spa-embedded: ok size=$SIZE path=$BIN"
