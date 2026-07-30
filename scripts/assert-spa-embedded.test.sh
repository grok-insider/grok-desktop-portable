#!/usr/bin/env sh
# Drives the real assert-spa-embedded.sh against real binaries/fixtures.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
ASSERT="$ROOT/scripts/assert-spa-embedded.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Missing path must fail.
if "$ASSERT" "$TMP/nope" 2>/dev/null; then
  echo "expected failure for missing binary" >&2
  exit 1
fi

# Tiny non-SPA file must fail.
printf 'not a spa binary' >"$TMP/tiny"
if "$ASSERT" "$TMP/tiny" 2>/dev/null; then
  echo "expected failure for tiny non-SPA file" >&2
  exit 1
fi

# Real release or debug bridge with SPA (if built).
BIN=""
for candidate in \
  "$ROOT/target/release/grok-bridge" \
  "$ROOT/target/debug/grok-bridge"
do
  if [ -f "$candidate" ]; then
    BIN=$candidate
    break
  fi
done

if [ -n "$BIN" ]; then
  "$ASSERT" "$BIN"
  echo "assert-spa-embedded.test.sh: ok (real binary $BIN)"
else
  # Synthesize a file large enough with SPA markers so the script path is tested
  # without requiring a prior cargo build in pure unit environments.
  {
    printf '#!/bin/sh\n'
    # pad to > 5MB
    dd if=/dev/zero bs=1024 count=5200 2>/dev/null
    printf 'index.html\n/assets/index.js\nibm-plex\ntext/html; charset=utf-8\n'
  } >"$TMP/fake-bridge"
  "$ASSERT" "$TMP/fake-bridge"
  echo "assert-spa-embedded.test.sh: ok (synthetic SPA marker file)"
fi
