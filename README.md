# @nerima-games/mc-server

`@nerima-games/mc-server` is the planned Node host for the Minecraft server. This repository currently provides package tooling, a `serverPackageName` export, and a placeholder CLI; it does not start a server.

Install dependencies with `nix develop --command pnpm install --frozen-lockfile`. Run `nix develop --command pnpm verify` for typecheck, lint, and tests; `nix develop --command pnpm package:verify` checks the built package.

See [responsibility](docs/responsibility.md) and [public API](docs/public-api.md).
