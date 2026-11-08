# Responsibility

## Current ownership

`apps/multiplayer-server/main.ts` runs the Node WebSocket host. It owns the listener and CLI, optional state-file persistence, and the 50 ms server tick loop. The host creates multiplayer cores for the Overworld, Nether, and End; each tick advances those cores and the `mx-redstone` runtime. After binding, it prints the WebSocket address.

State stays in memory unless `--state-file` or `MULTIPLAYER_STATE_FILE` configures a persistence file. The host reads legacy player claims from the path set by `--legacy-player-claims-file` or `MULTIPLAYER_LEGACY_PLAYER_CLAIMS_FILE`. `apps/multiplayer-server/legacy-player-claims.ts` uses Node cryptography to validate per-player secret hashes.

## Out of scope

`mc-sim` is the simulation package and owns simulation state, clock, random source, and the test harness. `mx-multiplayer` owns the multiplayer protocol, validation, command ledger, and anti-cheat. It defines the typed interface for world-state write requests; `mc-server` supplies the host implementation when it composes `mx-redstone`. UI, browser DOM, E2E tests, and game rule implementations remain outside this host package.
