{
  description = "mc-server: Node host for the Minecraft multiplayer server.";

  inputs = {
    # flake.lock pins nixpkgs to 624af665, providing oxlint 1.75.0. That version
    # avoids false no-redeclare diagnostics on Effect 4 type/value declarations.
    # Revisit the pin when newer oxlint versions stop emitting those diagnostics.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      # The workflow in .github/workflows/ci.yaml runs on x86_64-linux;
      # maintainers test aarch64-darwin. List only tested systems so
      # `nix flake check --all-systems` checks supported outputs.
      systems = [
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          # CI pins Node 26 in .github/workflows/ci.yaml; engines.node accepts
          # Node 24. corepack_24 supplies the shim, which uses Node from PATH.
          # package.json's packageManager field selects pnpm 12.14.0.
          #
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_26
              pkgs.corepack_24
              pkgs.typescript-language-server
              pkgs.oxlint
              pkgs.ast-grep
            ];

            shellHook = ''
              corepackDir="$(mktemp -d "''${TMPDIR:-/tmp}/mc-server-corepack.XXXXXX")"
              corepack enable --install-directory "$corepackDir"
              export PATH="$corepackDir:$PATH"
            '';
          };
        }
      );
    };
}
