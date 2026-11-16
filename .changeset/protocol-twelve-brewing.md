---
"@nerima-games/mc-server": minor
---

Use mx-multiplayer 0.18.0 protocol 12 for brewing commands and deltas. Remove the brewing codec exports from `@nerima-games/mc-server/shared`; consumers must import brewing messages from mx-multiplayer. Protocol versions must match exactly.

Simulate three indexed bottles with mc-sim brewing rules. Drink potions from player inventory slots and return glass bottles. Reject brewing inserts from named or enchanted inventory slots. Preserve furnace station and total burn ticks in snapshots and deltas.

Write format 3 saves and migrate formats 1 and 2 on load. Complete in-progress legacy brewing immediately on load in bottle slot 0, retain up to 20 fuel charges, and convert excess charges into at most 64 blaze powder. Reject invalid saves and excess fuel beyond one stack with typed failures. Keep hidden status effects in authoritative state and saves; send only visible effect fields to clients, including an effect resumed during the same tick.
