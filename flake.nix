{
  description = "Grok Desktop Portable — grok-bridge package";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      portableRoot = ./.;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          # The flake source excludes the gitignored apps/web/dist; build.rs then
          # embeds its placeholder page. Call nix/package.nix with a path to a
          # checkout that holds a built dist to embed the real SPA.
          grok-bridge = pkgs.callPackage ./nix/package.nix {
            portableSrc = portableRoot;
            requireWebDist = false;
          };
        in
        {
          default = grok-bridge;
          inherit grok-bridge;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/grok-bridge";
        };
      });
    };
}
