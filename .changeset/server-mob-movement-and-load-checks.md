---
"@nerima-games/mc-server": minor
---

Move passive mobs on the server, and refuse to start on saves that made every server tick fail.

- Passive mobs such as cows now walk, using mx-gameplay 0.12.0's movement planner, and treat blocks players placed as terrain. Their movement is not saved, so after a restart they start at rest.
- Startup fails, and logs the failure tag, when the save holds a block name the block registry lacks (`BlockOverrideNotInRegistry`), a furnace the smelting rules reject (`SavedFurnaceInvalid`), a Wither skull outside mc-sim's projectile rules (`WitherSkullOutsideProjectileRules`), a position outside addressable cells (`PositionOutsideAddressableCells`), or a mob state mx-gameplay cannot repair (`MobStateRepairFailure`). Such a save used to load and then fail the same step on every tick.
