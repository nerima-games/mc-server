---
"@nerima-games/mc-server": minor
---

Rebuild the `./shared` sleep adapter on mx-multiplayer 0.17 intents and mx-gameplay sleep rules.

The sleep wire JSON keeps its shape, except that `cooldown-active` is no longer a sleep rejection reason. The adapter never produces it: none of the public APIs of mx-gameplay 0.11.0, mc-kernel, or mc-sim has a matching rule, and the server does not reproduce the old mx-multiplayer rule (ruling R-U6a3-1 C). `decodeSleepWireMessage` now rejects a result that carries it. TypeScript clients see these type changes:

- `SleepCommand` is now declared by this package and keeps `clientTick`. It is no longer derived from mx-multiplayer's `SurvivalCommand`.
- `SleepRejectionReason` and `SleepCommandResult` are new. `SleepWireMessage` carries `SleepCommandResult` in `SleepCommandResult` messages, `SleepClientState.rejection` holds it, and `applySleepCommandResult` takes it. Before, all three used mx-multiplayer's `SurvivalCommandResult`, which no longer carries `revision` or `events`.
- `SleepAuthority` is created with `SleepAuthority.make(snapshot, options)`, which returns a `Result`. `options` is the new `SleepAuthorityOptions`, which takes a `sleepRatio` from the new `sleepRatio(percentage)` parser, an optional `reach` (default: mx-gameplay's `DEFAULT_BLOCK_REACH`), and the `validateSleep` callback. `execute` now also takes a `SleepIntentContext`, and `addActor` accepts only awake actors (`SleepAwakeActor`).
