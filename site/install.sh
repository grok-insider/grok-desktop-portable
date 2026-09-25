#!/usr/bin/env sh
# Public installer for the desktop.grok.me local host.
# Served at: https://desktop.grok.me/install.sh
#
# The host is `spanreed agent` (formerly the standalone grok-bridge). This
# installs the Spanreed CLI into ~/.local/bin and links `grok-bridge` to it so
# existing commands keep working.
#
# This file is intentionally NOT configurable via environment variables.
# It always installs the newest release of the official repo (including
# prereleases). That keeps `curl | sh` from the site deterministic and
# resistant to ambient env poisoning.
#
# Usage:
#   curl -fsSL https://desktop.grok.me/install.sh | sh
#   curl -fsSL https://desktop.grok.me/install.sh | sh -s -- --dry-run
#
# For forks / custom install dir / pinned tags, clone the repo and use
# install/install.sh (those knobs are for operators, not the public URL).
set -eu

# --- fixed product constants (do not read env for these) ---
REPO="grok-insider/spanreed"
# Used only if the GitHub API is unreachable: the first release with `spanreed agent`.
FALLBACK_TAG="v0.7.0"
INSTALL_DIR="${HOME}/.local/bin"
BIN_NAME="spanreed"
LEGACY_NAME="grok-bridge"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    -h | --help)
      sed -n '2,19p' "$0" 2>/dev/null || true
      exit 0
      ;;
    *)
      echo "error: unknown argument: $arg (public installer accepts only --dry-run)" >&2
      exit 1
      ;;
  esac
done

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os/$arch" in
  linux/x86_64 | linux/amd64) target=x86_64-unknown-linux-musl ;;
  darwin/arm64 | darwin/aarch64) target=aarch64-apple-darwin ;;
  darwin/x86_64 | darwin/amd64) target=x86_64-apple-darwin ;;
  mingw*/* | msys*/* | cygwin*/*)
    echo "Use install.ps1 on Windows (https://desktop.grok.me/install.ps1)" >&2
    exit 1
    ;;
  *)
    echo "unsupported platform: $os/$arch (Linux x86_64 and macOS arm64/x86_64 are supported)" >&2
    exit 1
    ;;
esac

# Newest GitHub release including prereleases (not /releases/latest).
resolve_tag() {
  api="https://api.github.com/repos/${REPO}/releases?per_page=20"
  json=$(curl -fsSL -H "Accept: application/vnd.github+json" "$api" 2>/dev/null || true)
  tag=""
  if [ -n "$json" ]; then
    tag=$(
      printf '%s' "$json" \
        | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
        | head -n1 \
        | sed 's/.*"\([^"]*\)"$/\1/'
    )
  fi
  if [ -z "$tag" ]; then
    echo "warning: could not resolve latest release via API; using ${FALLBACK_TAG}" >&2
    tag=$FALLBACK_TAG
  fi
  printf '%s\n' "$tag"
}

VERSION=$(resolve_tag)
asset="${BIN_NAME}-${VERSION#v}-${target}.tar.gz"
base="https://github.com/${REPO}/releases/download/${VERSION}"

if [ "$DRY_RUN" = 1 ]; then
  echo "RESOLVED_TAG=${VERSION}"
  echo "TARGET=${target}"
  echo "DOWNLOAD_URL=${base}/${asset}"
  echo "CHECKSUM_URL=${base}/${asset}.sha256"
  echo "INSTALL_DIR=${INSTALL_DIR}"
  curl -fsSIL "${base}/${asset}" >/dev/null
  curl -fsSIL "${base}/${asset}.sha256" >/dev/null
  echo "DRY_RUN_OK"
  exit 0
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

echo "Downloading ${asset} (${VERSION}) from ${REPO}…"
curl -fsSL "${base}/${asset}" -o "${tmpdir}/${asset}"
curl -fsSL "${base}/${asset}.sha256" -o "${tmpdir}/${asset}.sha256" || {
  echo "error: ${asset}.sha256 required but not found for ${VERSION}" >&2
  exit 1
}

expected=$(awk -v name="$asset" '$2 == name {print $1}' "${tmpdir}/${asset}.sha256" | head -n1)
if [ -z "$expected" ]; then
  echo "error: ${asset}.sha256 does not describe ${asset}" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "${tmpdir}/${asset}" | awk '{print $1}')
else
  actual=$(shasum -a 256 "${tmpdir}/${asset}" | awk '{print $1}')
fi
if [ "$actual" != "$expected" ]; then
  echo "error: checksum mismatch for ${asset}" >&2
  echo "  expected: $expected" >&2
  echo "  actual:   $actual" >&2
  exit 1
fi
echo "Checksum OK"

tar -xzf "${tmpdir}/${asset}" -C "$tmpdir" "$BIN_NAME"
mkdir -p "$INSTALL_DIR"
install -m 755 "${tmpdir}/${BIN_NAME}" "${INSTALL_DIR}/${BIN_NAME}"
ln -sf "$BIN_NAME" "${INSTALL_DIR}/${LEGACY_NAME}"
echo "Installed ${INSTALL_DIR}/${BIN_NAME} (and ${LEGACY_NAME} → ${BIN_NAME} agent)"

case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo "Add ${INSTALL_DIR} to your PATH if needed."
    ;;
esac

echo
echo "Next:"
echo "  1. Install and authenticate the Grok Build CLI (grok) separately."
echo "  2. ${BIN_NAME} agent doctor"
echo "  3. ${BIN_NAME} agent serve   # leave running"
echo "  4. ${BIN_NAME} agent open    # open the URL in Chrome, Firefox 84+, or Edge (not Safari)"
