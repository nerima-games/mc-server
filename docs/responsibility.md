# Responsibility

## Planned ownership

`mc-server` composes game modules for a Node server and drives simulation ticks. It owns the listener and CLI, the `READY:` status line, server-state file persistence, and host integration with the redstone behavior package `mx-redstone`.

The host supplies filesystem and cryptography adapters for the `legacy-player-claims` file, which stores per-player secret hashes. The host implementation will specify the exact `READY:` line and tick schedule.

## Out of scope

`mc-sim` is the simulation package and owns simulation state, clock, random source, and the test harness. `mx-multiplayer` owns the multiplayer protocol, validation, command ledger, and anti-cheat. It defines the generic interface for requesting world-state writes; `mc-kernel` defines the shared TypeScript type for that port. `mc-server` supplies its implementation when it composes `mx-redstone`. UI, browser DOM, E2E tests, and game rule implementations remain outside this host package.
