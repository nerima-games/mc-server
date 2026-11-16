---
"@nerima-games/mc-server": minor
---

Add a WorldWritePort adapter backed by WorldCommitCoordinator and wire a separate coordinator to each server core and its ChunkStore. Block mutation callers will migrate to the port in a subsequent change.
