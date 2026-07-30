#!/usr/bin/env sh
# Install grok-bridge from GitHub Releases (Grok Desktop Portable).
# Usage:
#   curl -fsSL https://desktop.grok.me/install.sh | sh
#   VERSION=v0.1.0-beta.1 curl -fsSL https://desktop.grok.me/install.sh | sh
#
# VERSION=latest (default) resolves the newest GitHub release *including
# prereleases* via the API. GitHub's /releases/latest URL skips prereleases
# and 404s when only betas are published.
set -eu

REPO="${GROK_BRIDGE_REPO:-grok-insider/grok-desktop-portable}"
VERSION="${VERSION:-latest}"
# Used when VERSION=latest and the API is unreachable.
FALLBACK_TAG="${GROK_BRIDGE_FALLBACK_TAG:-v0.1.0-beta.1}"
INSTALL_DIR="${GROK_BRIDGE_INSTALL_DIR:-${HOME}/.local/bin}"
BIN_NAME="grok-bridge"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os" in
  linux) platform=linux ;;
  darwin) platform=darwin ;;
  mingw*|msys*|cygwin*)
    echo "Use install.ps1 on Windows (https://desktop.grok.me/install.ps1)" >&2
    exit 1
    ;;
  *)
    echo "unsupported OS: $os" >&2
    exit 1
    ;;
esac
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *)
    echo "unsupported architecture: $arch" >&2
    exit 1
    ;;
esac

asset="${BIN_NAME}-${platform}-${arch}"

# Resolve VERSION=latest to a concrete tag (prereleases included).
resolve_tag() {
  want=$1
  if [ "$want" != "latest" ]; then
    printf '%s\n' "$want"
    return 0
  fi
  # releases?per_page lists newest first and includes prereleases.
  # Avoid /releases/latest — that endpoint ignores prerelease-only channels.
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

# Dry-run: prove URL resolution without writing to the user install dir.
if [ "${INSTALL_DRY_RUN:-0}" = "1" ]; then
  echo "RESOLVED_TAG=${VERSION}"
  echo "DOWNLOAD_URL=${base}/${asset}"
  echo "CHECKSUMS_URL=${base}/checksums.txt"
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
  echo "warning: checksums.txt not found; skipping verify" >&2
  checksums_missing=1
}

if [ "${checksums_missing:-0}" != 1 ]; then
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
fi

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
