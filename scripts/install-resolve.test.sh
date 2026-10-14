#!/usr/bin/env sh
# Drive the real installers with stubbed `uname` and `curl`, so platform
# detection, checksum verification and the grok-bridge link are checked
# offline. `curl` serves a fake release built here from a stand-in binary.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
PUBLIC="$ROOT/site/install.sh"
OPERATOR="$ROOT/install/install.sh"
SCRATCH="${INSTALL_TEST_SCRATCH:-$(mktemp -d)}"
mkdir -p "$SCRATCH"
fail() {
  echo "install-resolve.test.sh: $*" >&2
  exit 1
}

if grep -E 'releases/latest/download' "$PUBLIC" "$ROOT/site/install.ps1" >/dev/null; then
  fail "install scripts must not hardcode releases/latest/download"
fi
for forbidden in SPANREED_REPO SPANREED_FALLBACK_TAG SPANREED_INSTALL_DIR INSTALL_DRY_RUN \
  'VERSION:-' 'env:VERSION' 'env:SPANREED' 'env:INSTALL_DRY_RUN' GROK_BRIDGE_REPO; do
  if grep -F "$forbidden" "$PUBLIC" "$ROOT/site/install.ps1" >/dev/null; then
    fail "public install scripts must not reference override knob: $forbidden"
  fi
done
grep -q 'grok-insider/spanreed' "$PUBLIC" || fail "public installer must install Spanreed"
grep -q 'grok-insider/spanreed' "$ROOT/site/install.ps1" || fail "install.ps1 must install Spanreed"
grep -q 'x86_64-pc-windows-msvc' "$ROOT/site/install.ps1" || fail "install.ps1 target"
grep -q 'grok-bridge.exe' "$ROOT/site/install.ps1" || fail "install.ps1 keeps grok-bridge.exe"

VERSION_TAG=v9.9.9
RELEASE="$SCRATCH/release"
STUBS="$SCRATCH/stubs"
rm -rf "$RELEASE" "$STUBS"
mkdir -p "$RELEASE" "$STUBS"
printf '{"tag_name":"%s","draft":false,"prerelease":false}\n' "$VERSION_TAG" > "$SCRATCH/release-api.json"

# A stand-in `spanreed` that reports how it was invoked.
cat >"$SCRATCH/spanreed" <<'EOF'
#!/bin/sh
echo "argv0=$(basename "$0") args=$*"
EOF
chmod +x "$SCRATCH/spanreed"
for target in x86_64-unknown-linux-musl aarch64-apple-darwin x86_64-apple-darwin; do
  asset="spanreed-${VERSION_TAG#v}-$target.tar.gz"
  tar -czf "$RELEASE/$asset" -C "$SCRATCH" spanreed
  (cd "$RELEASE" && sha256sum "$asset" >"$asset.sha256")
done

cat >"$STUBS/uname" <<'EOF'
#!/bin/sh
case "$1" in
  -s) echo "$FAKE_OS" ;;
  -m) echo "$FAKE_ARCH" ;;
esac
EOF
cat >"$STUBS/curl" <<EOF
#!/bin/sh
url=""
out=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -o) out=\$2; shift ;;
    http*) url=\$1 ;;
  esac
  shift
done
echo "\$url" >>"$SCRATCH/curl.log"
case "\$url" in
  https://api.github.com/repos/grok-insider/spanreed/releases/latest)
    [ -f "$SCRATCH/api-failure" ] && exit 22
    cat "$SCRATCH/release-api.json" ;;
  https://github.com/grok-insider/spanreed/releases/download/$VERSION_TAG/*)
    file="$RELEASE/\${url##*/}"
    [ -f "\$file" ] || exit 22
    if [ -n "\$out" ]; then cp "\$file" "\$out"; fi ;;
  *) exit 22 ;;
esac
EOF
chmod +x "$STUBS/uname" "$STUBS/curl"

run() {
  env -i PATH="$STUBS:$PATH" HOME="$SCRATCH/home" FAKE_OS="$1" FAKE_ARCH="$2" \
    VERSION=v0.0.0-evil SPANREED_REPO=evil/evil SPANREED_INSTALL_DIR=/tmp/evil INSTALL_DRY_RUN=1 \
    sh "$PUBLIC" --dry-run
}

check_target() {
  out=$(run "$1" "$2") || fail "$1/$2 dry run failed: $out"
  echo "$out" | grep -qx "TARGET=$3" || fail "$1/$2 resolved: $out"
  echo "$out" | grep -qx "DOWNLOAD_URL=https://github.com/grok-insider/spanreed/releases/download/$VERSION_TAG/spanreed-${VERSION_TAG#v}-$3.tar.gz" \
    || fail "$1/$2 url: $out"
  echo "$out" | grep -q '^DRY_RUN_OK$' || fail "$1/$2 not ok: $out"
  if echo "$out" | grep -q evil; then fail "public installer honored poisoned env"; fi
}
check_target Linux x86_64 x86_64-unknown-linux-musl
check_target Darwin arm64 aarch64-apple-darwin
check_target Darwin x86_64 x86_64-apple-darwin
touch "$SCRATCH/api-failure"
if run Linux x86_64 >"$SCRATCH/api-failure.out" 2>&1; then
  fail "an unavailable release API must not install a fallback"
fi
rm "$SCRATCH/api-failure"
for response in '{"tag_name":"v9.9.9-preview.1"}' '{"tag_name":"v9.9.9","prerelease":true}' '{"tag_name":"v9.9.9","draft":true}' '{}' '{"tag_name":"v09.9.9"}' '{"tag_name":"V9.9.9"}'; do
  printf '%s\n' "$response" > "$SCRATCH/release-api.json"
  if run Linux x86_64 >"$SCRATCH/unstable.out" 2>&1; then
    fail "an unstable or missing tag must be rejected"
  fi
done
printf '{"tag_name":"%s","draft":false,"prerelease":false}\n' "$VERSION_TAG" > "$SCRATCH/release-api.json"
if run Linux aarch64 >"$SCRATCH/unsupported.out" 2>&1; then
  fail "Linux aarch64 has no release asset and must be refused"
fi
grep -q 'unsupported platform' "$SCRATCH/unsupported.out" || fail "unsupported message"

# A real install on macOS arm64 from the fake release: checksum, binary, link.
test_profile="$SCRATCH/home"
rm -rf "$test_profile"
mkdir -p "$test_profile"
env -i PATH="$STUBS:$PATH" HOME="$test_profile" FAKE_OS=Darwin FAKE_ARCH=arm64 sh "$PUBLIC" \
  >"$SCRATCH/install.log" 2>&1 || fail "install failed: $(cat "$SCRATCH/install.log")"
test -x "$test_profile/.local/bin/spanreed" || fail "spanreed not installed"
test -L "$test_profile/.local/bin/grok-bridge" || fail "grok-bridge link missing"
[ "$(readlink "$test_profile/.local/bin/grok-bridge")" = spanreed ] || fail "grok-bridge must point at spanreed"
"$test_profile/.local/bin/grok-bridge" status | grep -qx 'argv0=grok-bridge args=status' \
  || fail "grok-bridge link does not keep its name"
grep -q 'remote private-serve https://HOST' "$SCRATCH/install.log" || fail "private host instruction missing"
grep -q 'remote private-pair https://HOST' "$SCRATCH/install.log" || fail "private pairing instruction missing"
grep -q 'tailscale serve status' "$SCRATCH/install.log" || fail "existing Serve configuration instruction missing"
cp "$test_profile/.local/bin/spanreed" "$SCRATCH/good-binary"

for destination in spanreed grok-bridge; do
  for kind in directory directory-link; do
    rm -rf "$test_profile/.local/bin/$destination" "$test_profile/.local/bin/other-directory"
    if [ "$kind" = directory ]; then
      mkdir "$test_profile/.local/bin/$destination"
    else
      mkdir "$test_profile/.local/bin/other-directory"
      ln -s other-directory "$test_profile/.local/bin/$destination"
    fi
    printf 'preserved' > "$test_profile/.local/bin/$destination/unrelated"
    if env -i PATH="$STUBS:$PATH" HOME="$test_profile" FAKE_OS=Darwin FAKE_ARCH=arm64 sh "$PUBLIC" \
      >"$SCRATCH/destination.log" 2>&1; then
      fail "$destination $kind must be refused"
    fi
    grep -q 'destination must be' "$SCRATCH/destination.log" || fail "unsafe destination message"
    [ "$(cat "$test_profile/.local/bin/$destination/unrelated")" = preserved ] || fail "unsafe destination contents changed"
    [ "$(find "$test_profile/.local/bin/$destination/" -type f | wc -l)" -eq 1 ] || fail "staged binary moved into directory"
    rm -rf "$test_profile/.local/bin/$destination" "$test_profile/.local/bin/other-directory"
    cp "$SCRATCH/good-binary" "$test_profile/.local/bin/spanreed"
    ln -sfn spanreed "$test_profile/.local/bin/grok-bridge"
  done
done

cat > "$STUBS/install" <<'EOF'
#!/bin/sh
printf partial > "$4"
echo 'synthetic disk full' >&2
exit 1
EOF
chmod +x "$STUBS/install"
if env -i PATH="$STUBS:$PATH" HOME="$test_profile" FAKE_OS=Darwin FAKE_ARCH=arm64 sh "$PUBLIC" \
  >"$SCRATCH/partial-copy.log" 2>&1; then
  fail "partial staging copy must fail"
fi
grep -q 'synthetic disk full' "$SCRATCH/partial-copy.log" || fail "copy failure message"
cmp "$test_profile/.local/bin/spanreed" "$SCRATCH/good-binary" || fail "copy failure replaced old binary"
[ "$(find "$test_profile/.local/bin" -name '.spanreed-install.*' | wc -l)" -eq 0 ] || fail "failed staging file leaked"
rm "$STUBS/install"

# A tampered checksum is refused.
asset="spanreed-${VERSION_TAG#v}-aarch64-apple-darwin.tar.gz"
cp "$RELEASE/$asset.sha256" "$SCRATCH/good.sha256"
printf '%s  %s\n' 0000000000000000000000000000000000000000000000000000000000000000 "$asset" \
  >"$RELEASE/$asset.sha256"
if env -i PATH="$STUBS:$PATH" HOME="$test_profile" FAKE_OS=Darwin FAKE_ARCH=arm64 sh "$PUBLIC" \
  >"$SCRATCH/tampered.log" 2>&1; then
  fail "a checksum mismatch must abort the install"
fi
grep -q 'checksum mismatch' "$SCRATCH/tampered.log" || fail "mismatch message"
cp "$SCRATCH/good.sha256" "$RELEASE/$asset.sha256"

# The operator installer honours its overrides.
op_dir="$SCRATCH/op-bin"
rm -rf "$op_dir"
env -i PATH="$STUBS:$PATH" HOME="$test_profile" FAKE_OS=Linux FAKE_ARCH=x86_64 \
  VERSION="$VERSION_TAG" SPANREED_INSTALL_DIR="$op_dir" sh "$OPERATOR" \
  >"$SCRATCH/operator.log" 2>&1 || fail "operator install failed: $(cat "$SCRATCH/operator.log")"
test -x "$op_dir/spanreed" || fail "operator install dir ignored"
test -L "$op_dir/grok-bridge" || fail "operator grok-bridge link missing"

echo "install-resolve.test.sh: ok"
