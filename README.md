# @nerima-games/mc-server

`@nerima-games/mc-server` provides the Node multiplayer server and the shared multiplayer API used by its hosts.

## Development from a checkout

Run these commands from the repository root to install dependencies and build the server:

```sh
nix develop --command pnpm install --frozen-lockfile
nix develop --command pnpm build
```

Start the built server with `nix develop --command node dist/apps/multiplayer-server/main.js`. It listens on `127.0.0.1:5182` by default. Set `--host` and `--port`, or the `MULTIPLAYER_HOST` and `MULTIPLAYER_PORT` environment variables, to change the address.

The package's `mc-server` executable uses the same entry point.

Import shared helpers from the `shared` subpath:

```ts
import { isValidAnvilName } from "@nerima-games/mc-server/shared"
```

Run `nix develop --command pnpm verify` for typecheck, lint, and tests. Run `nix develop --command pnpm package:verify` to build and inspect the package archive.

See [responsibility](docs/responsibility.md) and [public API](docs/public-api.md).
