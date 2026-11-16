---
"@nerima-games/mc-server": minor
---

Route server block writes through WorldCommitCoordinator. Replace echoed BlockPlace and BlockBreak messages with ReplicatedWorldDelta, and send ReplicatedWorldSnapshot on join, resync, and realm transfer.

Reject edits outside 0 <= y < CHUNK_HEIGHT. Explosions now change blocks only in loaded chunks. Explosions within one entity or wither step share one batch, so world revision advances once per batch.

Preserve committed edits and block states across chunk reloads and server saves using an optional block state field in format 1 saves.

Discard and log block-write batches that fail with a typed error, then continue the remaining tick steps. Log tick defects and continue processing subsequent ticks.
