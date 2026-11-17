---
"@nerima-games/mc-server": minor
---

Use mx-multiplayer 0.18.0 protocol 12 for brewing commands and deltas. Remove the brewing codec exports from `@nerima-games/mc-server/shared`; consumers must import brewing messages from mx-multiplayer. Protocol versions must match exactly.

Simulate three indexed bottles with mc-sim brewing rules. Drink potions from player inventory slots and return glass bottles. Reject brewing inserts from named or enchanted inventory slots. Preserve furnace station and total burn ticks in snapshots and deltas. Legacy saves restore station as furnace and total burn ticks as the saved remaining burn ticks.

Write format 3 saves and migrate formats 1 and 2 on load. Complete in-progress legacy brewing immediately in bottle slot 0. Legacy brewing already consumed its ingredient and one fuel unit when it started; completing the recorded output avoids consuming them again and forgives the remaining brewing time.

Match the single-player fuel migration: retain up to 20 fuel charges and convert excess fuel units to blaze powder with ceil(excess / 20). The legacy model credited one unit per consumed blaze powder. If conversion would produce more than 64 powder, fail the entire save load with a typed error and leave the original file unchanged. Preserve file paths and filesystem error codes when a save cannot be loaded.

Keep hidden status effects in authoritative state and saves; send only visible effect fields to clients, including an effect resumed during the same tick. Validate the entire effect state, including hidden effects, when restoring state or transferring a player. Supported visible types are poison, regeneration, speed, hunger and nausea; reject other visible types.
