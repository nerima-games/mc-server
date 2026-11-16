---
"@nerima-games/mc-server": minor
---

Add a WorldWritePort adapter backed by WorldCommitCoordinator and wire a separate coordinator to each server core and its ChunkStore.

Reject server startup with WorldWriteInitializationFailure when the world identifier is empty.

Fail mismatched world or dimension batches with Effect.die before commit, leaving ChunkStores unchanged.
