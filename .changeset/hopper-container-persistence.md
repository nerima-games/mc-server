---
"@nerima-games/mc-server": minor
---

Use mc-sim ContainerStorageService as the container authority and HopperService for hopper transfers and cooldowns. Transfer block and container changes in one coordinator commit, then broadcast protocol 11 container projections. Hoppers without saved block state face down and start enabled; explicit states are preserved.

Write format 2 state files with LegacyItemStackSchema and migrate format 1 saves on load. Preserve container item components and durability across transfers and restarts, including durability tracked in player inventory tables. Store container IDs by dimension while retaining world-scoped client IDs. Reject unknown kernel items in format 1 saves at startup. Log persistence failures immediately and stop the runtime.

Protocol 11 inventories and item drops cannot represent nondefault item components. For containers loaded from externally authored format 2 saves containing such items, breaking the block is rejected and reported to the sender. Dispenser and dropper activations stop at the first occupied slot when its components cannot be represented, logging each refusal.

Moving a container with a piston or destroying it in an explosion removes its contents without item drops.

Remove the core applyHopperTransfer method. Core initialization now requires full-capacity canonical containers with dimension-based IDs; legacy migration belongs to the state-file loader. State-file writes return typed failures when items cannot be encoded or container IDs do not match the dimension.
