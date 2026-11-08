# Public API

The package root exports `serverPackageName`, the package identifier string.

The `@nerima-games/mc-server/shared` subpath re-exports these modules from `apps/multiplayer-shared` for use by server and browser hosts:

- `anvil-network`
- `anvil-repair`
- `brewing-network`
- `crafting-network`
- `enchanting-network`
- `ender-dragon-network`
- `player-damage-network`
- `sleep-network`
- `wither-network`
- `wither-runtime`

For example:

```ts
import { isValidAnvilName } from "@nerima-games/mc-server/shared"
```

`startMultiplayerServer` is an app-level export from `apps/multiplayer-server/main.ts`; it is not part of the package export map.
