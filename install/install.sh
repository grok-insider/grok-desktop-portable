#!/usr/bin/env sh
# Operator / clone installer for grok-bridge (optional env overrides).
# Prefer https://desktop.grok.me/install.sh for the locked public path.
#
# Usage:
#   ./install/install.sh
#   VERSION=v0.1.0 GROK_BRIDGE_INSTALL_DIR=/opt/bin ./install/install.sh
#   INSTALL_DRY_RUN=1 ./install/install.sh
set -eu

REPO="${GROK_BRIDGE_REPO:-grok-insider/grok-desktop-portable}"
VERSION="${VERSION:-latest}"
FALLBACK_TAG="${GROK_BRIDGE_FALLBACK_TAG:-v0.1.0}"
INSTALL_DIR="${GROK_BRIDGE_INSTALL_DIR:-${HOME}/.local/bin}"
BIN_NAME="grok-bridge"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os" in
  linux) platform=linux ;;
  darwin) platform=darwin ;;
  mingw* | msys* | cygwin*)
    echo "Use install/install.ps1 on Windows" >&2
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

resolve_tag() {
  want=$1
  if [ "$want" != "latest" ]; then
    printf '%s\n' "$want"
    return 0
  fi
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

VERSION=$(resolve_tag "$VERSION")
base="https://github.com/${REPO}/releases/download/${VERSION}"

if [ "${INSTALL_DRY_RUN:-0}" = "1" ]; then
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

echo "Downloading ${asset} (${VERSION})…"
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
  exit 1
fi
echo "Checksum OK"

mkdir -p "$INSTALL_DIR"
install -m 755 "${tmpdir}/${asset}" "${INSTALL_DIR}/${BIN_NAME}"
echo "Installed ${INSTALL_DIR}/${BIN_NAME}"
echo
echo "Next:"
echo "  1. Install and authenticate Grok Build CLI (grok) ≥ 0.2.115 separately."
echo "  2. ${BIN_NAME} doctor && ${BIN_NAME} serve && ${BIN_NAME} open"
echo "  Safari/WebKit unsupported; Chrome/Firefox 84+; no autostart in this beta."
