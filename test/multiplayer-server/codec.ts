import { createReplicatedOwnerRegistry, type ReplicatedOwnerRegistry } from '@nerima-games/mx-multiplayer'
import { Result } from 'effect'

// Host policy limits: the pinned protocol exposes no public codec budget constants.
export const replicatedOwners: ReplicatedOwnerRegistry = Result.getOrThrow(createReplicatedOwnerRegistry([], {
  maxCollectionItems: 31_149,
  maxDeltaBlockChanges: 31_149,
  maxDeltaFrameBytes: 4_194_304,
  maxDepth: 13,
  maxRegisteredOwners: 0,
  maxSnapshotBlockReads: 31_149,
  maxSnapshotFrameBytes: 4_194_304,
  ownerStates: [],
}))
