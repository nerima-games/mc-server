---
"@nerima-games/mc-server": minor
---

Use mc-sim ContainerStorageService as the container authority and HopperService for hopper transfers and cooldowns. Transfer block and container changes in one coordinator commit, then broadcast protocol 11 container projections. Hoppers without a saved facing value migrate to down; explicit facing values are preserved.

Write format 2 state files with LegacyItemStackSchema and migrate format 1 saves on load. Preserve container item components and durability across transfers and restarts. Store container IDs by dimension while retaining world-scoped client IDs.

Reject operations that would move nondefault container item components into protocol 11 inventories or item drops, which cannot represent them.

Remove the core applyHopperTransfer method. State-file writes now return a typed failure when an item cannot be encoded.
