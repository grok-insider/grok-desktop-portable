#!/usr/bin/env sh
# Public installer for the desktop.grok.me local host.
# Served at: https://desktop.grok.me/install.sh
#
# The host is `spanreed agent` (formerly the standalone grok-bridge). This
# installs the Spanreed CLI into ~/.local/bin and links `grok-bridge` to it so
# existing commands keep working.
#
# This file is intentionally NOT configurable via environment variables.
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

resolve_tag() {
  api="https://api.github.com/repos/${REPO}/releases/latest"
  json=$(curl -fsSL -H "Accept: application/vnd.github+json" "$api") || {
    echo "error: could not resolve the latest stable release; retry later" >&2
    return 1
  }
  if printf '%s' "$json" | grep -Eq '"(draft|prerelease)"[[:space:]]*:[[:space:]]*true'; then
    echo "error: latest release is not a published stable release" >&2
    return 1
  fi
  tag=""
  if [ -n "$json" ]; then
    tag=$(
      printf '%s' "$json" \
        | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
        | head -n1 \
        | sed 's/.*"\([^"]*\)"$/\1/'
    )
  fi
  if ! printf '%s\n' "$tag" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
    echo "error: latest release did not provide a stable version tag" >&2
    return 1
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
staged=""
trap '[ -z "$staged" ] || rm -f "$staged"; rm -rf "$tmpdir"' EXIT

echo "Downloading ${asset} (${VERSION}) from ${REPO}…"
curl -fsSL "${base}/${asset}" -o "${tmpdir}/${asset}"
curl -fsSL "${base}/${asset}.sha256" -o "${tmpdir}/${asset}.sha256" || {
  echo "error: ${asset}.sha256 required but not found for ${VERSION}" >&2
  exit 1
}

expected=$(awk -v name="$asset" 'NR == 1 && NF == 2 && $2 == name {hash = $1} END {if (NR == 1 && length(hash) == 64 && hash !~ /[^0-9a-fA-F]/) print tolower(hash)}' "${tmpdir}/${asset}.sha256")
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
[ -f "${tmpdir}/${BIN_NAME}" ] && [ ! -L "${tmpdir}/${BIN_NAME}" ] || {
  echo "error: archive must contain a regular ${BIN_NAME}" >&2
  exit 1
}
mkdir -p "$INSTALL_DIR"
dest="${INSTALL_DIR}/${BIN_NAME}"
legacy="${INSTALL_DIR}/${LEGACY_NAME}"
validate_destinations() {
  if [ -L "$dest" ] || { [ -e "$dest" ] && [ ! -f "$dest" ]; }; then
    echo "error: install destination must be a regular file or absent: $dest" >&2
    exit 1
  fi
  if [ -d "$legacy" ] || { [ -e "$legacy" ] && [ ! -f "$legacy" ] && [ ! -L "$legacy" ]; }; then
    echo "error: legacy destination must be a file or file link: $legacy" >&2
    exit 1
  fi
}
validate_destinations
staged=$(mktemp "${INSTALL_DIR}/.spanreed-install.XXXXXX")
install -m 755 "${tmpdir}/${BIN_NAME}" "$staged"
validate_destinations
mv -f "$staged" "$dest"
staged=""
ln -sfn "$BIN_NAME" "$legacy"
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
echo "  2. Connect this computer and your device to Tailscale; enable MagicDNS and HTTPS, and allow device access to TCP 443."
echo "  3. ${BIN_NAME} remote doctor"
echo "  4. ${BIN_NAME} remote private-serve https://HOST   # use this computer's Tailscale HTTPS hostname; leave running"
echo "  5. In another terminal, check 'tailscale serve status' before assigning its HTTPS root:"
echo "     tailscale serve --bg --https=443 http://127.0.0.1:PORT   # use the port printed by Spanreed"
echo "  6. ${BIN_NAME} remote private-pair https://HOST   # same hostname as step 4"
echo "  7. Open the one-use link on your device; it opens https://desktop.grok.me. Keep the computer running."
