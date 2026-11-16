# @nerima-games/mc-server

## 0.2.0

### Minor Changes

- Move the server and shared modules to Effect 4 and update their published dependencies.

- Move passive mobs on the server, and refuse to start on saves that made every server tick fail.
  
  - Passive mobs such as cows now walk, using mx-gameplay 0.12.0's movement planner, and treat blocks players placed as terrain. Their movement is not saved, so after a restart they start at rest.
  - Startup fails, and logs the failure tag, when the save holds a block name the block registry lacks (`BlockOverrideNotInRegistry`), a furnace the smelting rules reject (`SavedFurnaceInvalid`), a Wither skull outside mc-sim's projectile rules (`WitherSkullOutsideProjectileRules`), a position outside addressable cells (`PositionOutsideAddressableCells`), or a mob state mx-gameplay cannot repair (`MobStateRepairFailure`). Such a save used to load and then fail the same step on every tick.

- Rebuild the `./shared` sleep adapter on mx-multiplayer 0.17 intents and mx-gameplay sleep rules.
  
  The sleep wire JSON keeps its shape, except that `cooldown-active` is no longer a sleep rejection reason. The adapter never produces it: none of the public APIs of mx-gameplay 0.11.0, mc-kernel, or mc-sim has a matching rule, and the server does not reproduce the old mx-multiplayer rule (ruling R-U6a3-1 C). `decodeSleepWireMessage` now rejects a result that carries it. TypeScript clients see these type changes:
  
  - `SleepCommand` is now declared by this package and keeps `clientTick`. It is no longer derived from mx-multiplayer's `SurvivalCommand`.
  - `SleepRejectionReason` and `SleepCommandResult` are new. `SleepWireMessage` carries `SleepCommandResult` in `SleepCommandResult` messages, `SleepClientState.rejection` holds it, and `applySleepCommandResult` takes it. Before, all three used mx-multiplayer's `SurvivalCommandResult`, which no longer carries `revision` or `events`.
  - `SleepAuthority` is created with `SleepAuthority.make(snapshot, options)`, which returns a `Result`. `options` is the new `SleepAuthorityOptions`, which takes a `sleepRatio` from the new `sleepRatio(percentage)` parser, an optional `reach` (default: mx-gameplay's `DEFAULT_BLOCK_REACH`), and the `validateSleep` callback. `execute` now also takes a `SleepIntentContext`, and `addActor` accepts only awake actors (`SleepAwakeActor`).

## 0.1.0

### Minor Changes

- Add the multiplayer server runtime and public shared module entry point.
