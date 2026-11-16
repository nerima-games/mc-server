import {
  chunkKeyOfPosition,
  defaultBlockState,
  validateWorldWriteBatch,
  WorldWriteChunkUnavailable,
  WorldWriteCommitSchema,
  WorldWriteConflict,
  WorldWriteInvalidBatch,
  type WorldWriteBatch,
  type WorldWriteCommit,
  type WorldWritePort,
} from '@nerima-games/mc-kernel'
import {
  makeWorldCommitCoordinator,
  type WorldCommitCoordinatorApi,
  type WorldCommitCoordinatorError,
  type WorldCommitCoordinatorOptions,
  type ReplicatedWorldDelta,
  type ReplicatedOwnerChange,
  type ReplicatedOwnerCandidate,
} from '@nerima-games/mc-sim'
import { CHUNK_HEIGHT, type ChunkStoreRegistryApi, type Dimension } from '@nerima-games/mc-worldgen'
import { Effect, Result, Schema } from 'effect'

// Failures listed as invariant violations in the C7 ruling (section 3). The
// original failure stays reachable through the defect's `cause`.
const dieUnexpected = (failure: { readonly _tag: string }): Effect.Effect<never> =>
  Effect.die(new Error(`c7-adapter: unexpected ${failure._tag}`, { cause: failure }))

const invalidBlockState = (position: WorldWriteBatch['edits'][number]['position']) =>
  // The input is a literal of the codec's own encoded shape built from an
  // already decoded position, so a decode failure is a kernel codec defect.
  Schema.decodeEffect(WorldWriteInvalidBatch)({
    _tag: 'WorldWriteInvalidBatch',
    reason: 'invalid-block-state',
    position,
  }).pipe(Effect.catchTag('SchemaError', dieUnexpected))

const validateBeforeCommit = (batch: WorldWriteBatch) => Effect.gen(function* () {
  const validated = validateWorldWriteBatch(batch)
  if (Result.isFailure(validated)) return yield* Effect.fail(validated.failure)
  for (const edit of batch.edits) {
    if (edit.state === undefined && Result.isFailure(defaultBlockState(edit.block))) {
      return yield* Effect.fail(yield* invalidBlockState(edit.position))
    }
  }
})

const commitRequestOf = (batch: WorldWriteBatch, changes: ReadonlyArray<ReplicatedOwnerCandidate>) => ({
  expectedRevision: batch.expectedWorldRevision,
  expectedDimensions: [{ dimension: batch.dimension, expectedRevision: batch.expectedDimensionRevision }],
  changes,
  blockWrite: batch,
})

export const commitCoordinatorRequest = (
  coordinator: WorldCommitCoordinatorApi,
  request: import('@nerima-games/mc-sim').WorldCommitRequest,
): Effect.Effect<ReplicatedWorldDelta<ReplicatedOwnerChange>, WorldCommitCoordinatorError> =>
  coordinator.commit(request).pipe(Effect.catchTags({
    WorldWriteInvalidBatch: (failure) => Effect.fail(failure),
    WorldWriteChunkUnavailable: (failure) => Effect.fail(failure),
    WorldRevisionConflict: (failure) => Effect.fail(failure),
    DimensionRevisionConflict: (failure) => Effect.fail(failure),
    // A stale chunk with no current revision was unloaded or evicted
    // between prepare and publish. A present revision means a write or reload
    // bypassed the coordinator, which wiring must rule out.
    WorldWriteStale: (failure) => failure.actualRevision._tag === 'None'
      ? Effect.fail(new WorldWriteChunkUnavailable({ dimension: failure.dimension, chunk: failure.key }))
      : dieUnexpected(failure),
  }, (failure) => dieUnexpected(failure)))

export const commitBlockBatch = (
  coordinator: WorldCommitCoordinatorApi,
  expectedDimension: Dimension,
  batch: WorldWriteBatch,
  changes: ReadonlyArray<ReplicatedOwnerCandidate> = [],
): Effect.Effect<Readonly<{ commit: WorldWriteCommit; delta: ReplicatedWorldDelta<ReplicatedOwnerChange> }>,
  WorldWriteConflict | WorldWriteInvalidBatch | WorldWriteChunkUnavailable> => Effect.gen(function* () {
    yield* validateBeforeCommit(batch)
    if (batch.world !== coordinator.worldId) {
      return yield* Effect.die(new Error('c7-adapter: world mismatch', {
        cause: { batch: batch.world, coordinator: coordinator.worldId },
      }))
    }
    if (batch.dimension !== expectedDimension) {
      return yield* Effect.die(new Error('c7-adapter: dimension mismatch', {
        cause: { batch: batch.dimension, port: expectedDimension },
      }))
    }
    const outOfWorld = batch.edits.find(({ position }) => position.y < 0 || position.y >= CHUNK_HEIGHT)
    if (outOfWorld !== undefined) {
      return yield* Effect.fail(new WorldWriteChunkUnavailable({
        dimension: batch.dimension,
        chunk: chunkKeyOfPosition(outOfWorld.position),
      }))
    }
    const delta = yield* commitCoordinatorRequest(coordinator, commitRequestOf(batch, changes)).pipe(
      Effect.catchTags({
        WorldWriteInvalidBatch: (error) => Effect.fail(error),
        WorldWriteChunkUnavailable: (error) => Effect.fail(error),
        WorldRevisionConflict: (error) => Effect.flatMap(
          coordinator.dimensionRevision(batch.dimension),
          (currentDimensionRevision) => Effect.fail(new WorldWriteConflict({
            expectedWorldRevision: error.expected,
            currentWorldRevision: error.actual,
            expectedDimensionRevision: batch.expectedDimensionRevision,
            currentDimensionRevision,
          })),
        ),
        // The coordinator checks the dimension only after the world revision
        // matched, so the current world revision is the expected one.
        DimensionRevisionConflict: (error) => Effect.fail(new WorldWriteConflict({
          expectedWorldRevision: batch.expectedWorldRevision,
          currentWorldRevision: batch.expectedWorldRevision,
          expectedDimensionRevision: error.expected,
          currentDimensionRevision: error.actual,
        })),
      }, (error) => dieUnexpected(error)),
    )
    const commit = yield* Schema.decodeEffect(WorldWriteCommitSchema)({
      worldRevision: delta.revision,
      dimensionRevision: yield* coordinator.dimensionRevision(batch.dimension),
    }).pipe(Effect.catchTag('SchemaError', dieUnexpected))
    return { commit, delta }
})

export const makeWorldWritePortFromCoordinator = (
  coordinator: WorldCommitCoordinatorApi,
  expectedDimension: Dimension,
): WorldWritePort['Service'] => ({
  applyBatch: (batch) => Effect.map(commitBlockBatch(coordinator, expectedDimension, batch), ({ commit }) => commit),
})

export type ServerWorldWriteOptions = Omit<WorldCommitCoordinatorOptions, 'chunkStores' | 'dimensions'> & {
  readonly dimension: Dimension
  readonly chunkStores: ChunkStoreRegistryApi
}

export type ServerWorldWrite = {
  readonly coordinator: WorldCommitCoordinatorApi
  readonly port: WorldWritePort['Service']
}

/** Build a coordinator and scope-checked port for one server core. */
export const makeServerWorldWrite = (
  options: ServerWorldWriteOptions,
): Effect.Effect<ServerWorldWrite, WorldCommitCoordinatorError> => {
  const { dimension, ...coordinatorOptions } = options
  return Effect.map(makeWorldCommitCoordinator({ ...coordinatorOptions, dimensions: [dimension] }), (coordinator) => ({
    coordinator,
    port: makeWorldWritePortFromCoordinator(coordinator, dimension),
  }))
}
