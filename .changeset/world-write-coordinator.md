---
"@nerima-games/mc-server": minor
---

Add a WorldWritePort adapter backed by WorldCommitCoordinator and wire a separate coordinator to each server core and its ChunkStore. Legacy chunk reloads can discard port writes, so block mutation callers remain disconnected until that reload path is replaced.

Reject server startup with WorldWriteInitializationFailure when the world identifier is empty.

Reject writes targeting another world or dimension with WorldWriteChunkUnavailable, leaving ChunkStores unchanged.
