---
"@nerima-games/mc-server": minor
---

Route server block writes through WorldCommitCoordinator and broadcast committed block deltas. Reject edits outside 0 <= y < CHUNK_HEIGHT. Explosions now change blocks only in loaded chunks.

Preserve committed edits and block states across chunk reloads and server saves using an optional block state field in format 1 saves.

Log failed server ticks and continue processing subsequent ticks.
