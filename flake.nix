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
          # Use absolute filesystem path so apps/web/dist (gitignored) is visible.
          grok-bridge = pkgs.callPackage ./nix/package.nix {
            portableSrc = /home/friend/dev/opensource/grok-desktop-portable;
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
