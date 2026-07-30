{
  lib,
  rustPlatform,
  pkg-config,
  openssl,
  makeBinaryWrapper,
  # Absolute path preferred so untracked `apps/web/dist` is included for embed.
  # Flake callers may pass `self` (must ensure dist is present or pre-copied).
  portableSrc ? ../.,
}:

let
  # builtins.path materializes the tree from the filesystem (includes dist when
  # present). Relative `../.` works for callPackage from this file's directory.
  srcRoot =
    if builtins.isPath portableSrc || builtins.isString portableSrc then
      builtins.path {
        path = portableSrc;
        name = "grok-desktop-portable-src";
        filter =
          path: type:
          let
            base = baseNameOf path;
          in
          !(
            base == "target"
            || base == "node_modules"
            || base == "public"
            || base == ".git"
            || lib.hasSuffix ".log" base
          );
      }
    else
      portableSrc;
in
rustPlatform.buildRustPackage rec {
  pname = "grok-bridge";
  version = "0.1.0";

  src = srcRoot;

  cargoLock = {
    lockFile = src + "/Cargo.lock";
  };

  cargoBuildFlags = [
    "-p"
    "grok-bridge"
  ];
  doCheck = false;

  nativeBuildInputs = [
    pkg-config
    makeBinaryWrapper
  ];
  buildInputs = [ openssl ];

  preBuild = ''
    if [ ! -f apps/web/dist/index.html ]; then
      echo "grok-bridge: apps/web/dist/index.html missing in build source." >&2
      echo "Run: cd portable && pnpm build:web:dist" >&2
      exit 1
    fi
  '';

  postInstall = ''
    if [ ! -e "$out/bin/grok-bridge" ]; then
      found=$(find "$out" -type f -name grok-bridge | head -n1 || true)
      if [ -n "$found" ]; then
        mkdir -p "$out/bin"
        mv "$found" "$out/bin/grok-bridge"
      fi
    fi
    test -x "$out/bin/grok-bridge"
  '';

  meta = {
    description = "Grok Desktop Portable local bridge (Work UI for the user's Grok Build CLI)";
    mainProgram = "grok-bridge";
    license = lib.licenses.agpl3Plus;
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
