#!/usr/bin/env sh
# Public installer for grok-bridge (Grok Desktop Portable).
# Served at: https://desktop.grok.me/install.sh
#
# This file is intentionally NOT configurable via environment variables.
# It always installs the newest release of the official repo (including
# prereleases) into ~/.local/bin. That keeps `curl | sh` from the site
# deterministic and resistant to ambient env poisoning.
#
# Usage:
#   curl -fsSL https://desktop.grok.me/install.sh | sh
#   curl -fsSL https://desktop.grok.me/install.sh | sh -s -- --dry-run
#
# For forks / custom install dir / pinned tags, clone the repo and use
# install/install.sh (those knobs are for operators, not the public URL).
set -eu

# --- fixed product constants (do not read env for these) ---
REPO="grok-insider/grok-desktop-portable"
# Used only if the GitHub API is unreachable.
FALLBACK_TAG="v0.1.0-beta.2"
INSTALL_DIR="${HOME}/.local/bin"
BIN_NAME="grok-bridge"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    -h | --help)
      sed -n '2,16p' "$0" 2>/dev/null || true
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
case "$os" in
  linux) platform=linux ;;
  darwin) platform=darwin ;;
  mingw* | msys* | cygwin*)
    echo "Use install.ps1 on Windows (https://desktop.grok.me/install.ps1)" >&2
    exit 1
    ;;
  *)
    echo "unsupported OS: $os" >&2
    exit 1
    ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *)
    echo "unsupported architecture: $arch" >&2
    exit 1
    ;;
esac

asset="${BIN_NAME}-${platform}-${arch}"

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
base="https://github.com/${REPO}/releases/download/${VERSION}"

if [ "$DRY_RUN" = 1 ]; then
  echo "RESOLVED_TAG=${VERSION}"
  echo "DOWNLOAD_URL=${base}/${asset}"
  echo "CHECKSUMS_URL=${base}/checksums.txt"
  echo "INSTALL_DIR=${INSTALL_DIR}"
  curl -fsSIL "${base}/${asset}" >/dev/null
  curl -fsSIL "${base}/checksums.txt" >/dev/null
  echo "DRY_RUN_OK"
  exit 0
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

echo "Downloading ${asset} (${VERSION}) from ${REPO}…"
curl -fsSL "${base}/${asset}" -o "${tmpdir}/${asset}"
curl -fsSL "${base}/checksums.txt" -o "${tmpdir}/checksums.txt" || {
  echo "error: checksums.txt required but not found for ${VERSION}" >&2
  exit 1
}

expected=$(grep -E "[[:space:]]${asset}$" "${tmpdir}/checksums.txt" | awk '{print $1}' | head -n1)
if [ -z "$expected" ]; then
  echo "error: ${asset} not listed in checksums.txt" >&2
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

mkdir -p "$INSTALL_DIR"
install -m 755 "${tmpdir}/${asset}" "${INSTALL_DIR}/${BIN_NAME}"
echo "Installed ${INSTALL_DIR}/${BIN_NAME}"

case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo "Add ${INSTALL_DIR} to your PATH if needed."
    ;;
esac

echo
echo "Next:"
echo "  1. Install and authenticate the Grok Build CLI (grok)."
echo "  2. ${BIN_NAME} doctor"
echo "  3. ${BIN_NAME} serve"
echo "  4. ${BIN_NAME} open   # in another terminal; open the URL in Chrome/Firefox"
echo
echo "Unsigned FOSS build — prefer verifying checksums and source tags."
