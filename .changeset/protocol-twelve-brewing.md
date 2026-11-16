---
"@nerima-games/mc-server": minor
---

Use mx-multiplayer 0.18.0 protocol 12 for brewing commands and deltas. Remove the brewing codec exports from `@nerima-games/mc-server/shared`; consumers must import brewing messages from mx-multiplayer. Protocol versions must match exactly.

Simulate three indexed bottles with mc-sim brewing rules. Drink potions from player inventory slots and return glass bottles. Reject brewing inserts from named or enchanted inventory slots. Preserve furnace station and total burn ticks in snapshots and deltas. Legacy saves restore station as furnace and total burn ticks as the saved remaining burn ticks.

Write format 3 saves and migrate formats 1 and 2 on load. Complete in-progress legacy brewing immediately in bottle slot 0. Legacy brewing already consumed its ingredient and one fuel charge when it started; completing the recorded output avoids consuming them again and deliberately forgives the remaining brewing time.

Retain up to 20 fuel charges. Convert each complete group of 20 excess charges into one blaze powder, discarding the remaining 0–19 charges instead of rounding up and creating fuel. For example, 21 old charges become 20 charges with no powder and one discarded charge; 41 become 20 charges, one powder and one discarded charge. Reject conversions producing more than 64 powder, and reject invalid saves, with typed failures.

Keep hidden status effects in authoritative state and saves; send only visible effect fields to clients, including an effect resumed during the same tick.
