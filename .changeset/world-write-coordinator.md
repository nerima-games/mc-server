---
"@nerima-games/mc-server": minor
---

Add a WorldWritePort adapter backed by WorldCommitCoordinator and wire a separate coordinator to each server core and its ChunkStore. Legacy chunk reloads can discard port writes, so block mutation callers remain disconnected until that reload path is replaced.

Reject server startup with WorldWriteInitializationFailure when the world identifier is empty.

Fail mismatched world or dimension batches with Effect.die before commit, leaving ChunkStores unchanged.
