# @nerima-games/mc-server

## 0.3.0

### Minor Changes

- Use mc-sim ContainerStorageService as the container authority and HopperService for hopper transfers and cooldowns. Transfer block and container changes in one coordinator commit, then broadcast protocol 11 container projections. Hoppers without saved block state face down and start enabled; explicit states are preserved.
  
  Write format 2 state files with LegacyItemStackSchema and migrate format 1 saves on load. Preserve container item components and durability across transfers and restarts, including durability tracked in player inventory tables. Store container IDs by dimension while retaining world-scoped client IDs. Reject unknown kernel items in format 1 saves at startup. Log persistence failures immediately and stop the runtime.
  
  Protocol 11 inventories and item drops cannot represent nondefault item components. For containers loaded from externally authored format 2 saves containing such items, breaking the block is rejected and reported to the sender. Dispenser and dropper activations stop at the first occupied slot when its components cannot be represented, logging each refusal.
  
  Moving a container with a piston or destroying it in an explosion removes its contents without item drops.
  
  Remove the core applyHopperTransfer method. Core initialization now requires full-capacity canonical containers with dimension-based IDs; legacy migration belongs to the state-file loader. State-file writes return typed failures when items cannot be encoded or container IDs do not match the dimension.

- Use mx-multiplayer 0.18.0 protocol 12 for brewing commands and deltas. Remove the brewing codec exports from `@nerima-games/mc-server/shared`; consumers must import brewing messages from mx-multiplayer. Protocol versions must match exactly.
  
  Simulate three indexed bottles with mc-sim brewing rules. Drink potions from player inventory slots and return glass bottles. Reject brewing inserts from named or enchanted inventory slots. Preserve furnace station and total burn ticks in snapshots and deltas. Legacy saves restore station as furnace and total burn ticks as the saved remaining burn ticks.
  
  Write format 3 saves and migrate formats 1 and 2 on load. Complete in-progress legacy brewing immediately in bottle slot 0. Legacy brewing already consumed its ingredient and one fuel unit when it started; completing the recorded output avoids consuming them again and forgives the remaining brewing time.
  
  Match the single-player fuel migration: retain up to 20 fuel charges and convert excess fuel units to blaze powder with ceil(excess / 20). The legacy model credited one unit per consumed blaze powder. If conversion would produce more than 64 powder, fail the entire save load with a typed error and leave the original file unchanged. Preserve file paths and filesystem error codes when a save cannot be loaded.
  
  Keep hidden status effects in authoritative state and saves; send only visible effect fields to clients, including an effect resumed during the same tick. Validate the entire effect state, including hidden effects, when restoring state or transferring a player. Supported visible types are poison, regeneration, speed, hunger and nausea; reject other visible types.

- Add a WorldWritePort adapter backed by WorldCommitCoordinator and wire a separate coordinator to each server core and its ChunkStore.
  
  Reject server startup with WorldWriteInitializationFailure when the world identifier is empty.
  
  Fail mismatched world or dimension batches with Effect.die before commit, leaving ChunkStores unchanged.

- Route server block writes through WorldCommitCoordinator. Replace echoed BlockPlace and BlockBreak messages with ReplicatedWorldDelta, and send ReplicatedWorldSnapshot on join, resync, and realm transfer.
  
  Reject edits outside 0 <= y < CHUNK_HEIGHT. Explosions now change blocks only in loaded chunks. Explosions within one entity or wither step share one batch, so world revision advances once per batch.
  
  Preserve committed edits and block states across chunk reloads and server saves using an optional block state field in format 1 saves.
  
  Discard and log block-write batches that fail with a typed error, then continue the remaining tick steps. Log tick defects and continue processing subsequent ticks.

### Patch Changes

- Separate saved-state diagnostic fieldPath from filesystem filePath and retain actual errno codes. Report invalid realm-transfer state with RealmTransferStateFailure instead of a saved-file error.
  
  Reuse the validated status-effect wire projection while retaining authoritative hidden effects. Sequence placement and break encoding before mutation without dedicated empty-stand rejection branches. Document the pinned single-player fuel and ingredient acceptance rules.

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
