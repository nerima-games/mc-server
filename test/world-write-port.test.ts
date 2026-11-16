import fc from 'fast-check'
import { describe, expect, it } from '@effect/vitest'
import {
  AIR_BLOCK_ID,
  BlockAxis,
  blockIdOf,
  blockPosition,
  ChunkAxis,
  chunkCoord,
  chunkKeyOfPosition,
  itemStackFromUnknown,
  WorldIdSchema,
  WorldWriteBatchSchema,
  WorldWriteCommitSchema,
  WorldWriteConflict,
  WorldWriteInvalidBatch,
  WorldWriteChunkUnavailableSchema,
  type WorldWritePort,
} from '@nerima-games/mc-kernel'
import {
  CONTAINER_STORAGE_REPLICATED_OWNER_ID,
  ContainerStorageSnapshotSchema,
  containerStorageOwnerRegistration,
  makeReplicatedOwnerId,
  type ReplicatedOwnerRegistration,
  makeWorldCommitCoordinator,
  type WorldCommitCoordinatorApi,
} from '@nerima-games/mc-sim'
import {
  CHUNK_HEIGHT,
  CHUNK_SIZE_XZ,
  CHUNK_VOLUME,
  ChunkCapacity,
  EMPTY_DIRTY_BATCH,
  makeChunkStore,
  type ChunkBiomeType,
  type ChunkSource,
  type ChunkStoreApi,
  type ChunkStoreRegistryApi,
} from '@nerima-games/mc-worldgen'
import { Effect, Exit, Option, Ref, Result, Schema } from 'effect'

import { commitBlockBatch, makeServerWorldWrite, makeWorldWritePortFromCoordinator } from '../apps/multiplayer-server/world-write-port'

const OWNER = makeReplicatedOwnerId('server-owner')
const WORLD = 'server-world'
// Stone is a registered block in every kernel release; its absence would make
// every fixture below meaningless.
const STONE = Option.getOrThrow(blockIdOf('stone'))
const UNREGISTERED_BLOCK = 65535

const P = { x: 1, y: 10, z: 1 }
const Q = { x: 2, y: 10, z: 1 }
const at = (position: { readonly x: number; readonly y: number; readonly z: number }) =>
  blockPosition(BlockAxis(position.x), BlockAxis(position.y), BlockAxis(position.z))
const ORIGIN_CHUNK = chunkCoord(ChunkAxis(0), ChunkAxis(0))

const allAirChunkSource: ChunkSource = (coord) => Effect.succeed({
  coord,
  blocks: new Uint16Array(CHUNK_VOLUME).fill(AIR_BLOCK_ID),
  biomes: Array.from({ length: CHUNK_SIZE_XZ * CHUNK_SIZE_XZ }, (): ChunkBiomeType => 'PLAINS'),
})

type EncodedBatch = Schema.Codec.Encoded<typeof WorldWriteBatchSchema>
type EncodedEdit = EncodedBatch['edits'][number]

const batchOf = (overrides: Partial<EncodedBatch> = {}) => Schema.decodeUnknownEffect(WorldWriteBatchSchema)({
  world: WORLD,
  expectedWorldRevision: 0,
  dimension: 'overworld',
  expectedDimensionRevision: 0,
  edits: [{ position: P, block: STONE }],
  ...overrides,
})

const edit = (position: EncodedEdit['position'], block: number = STONE): EncodedEdit => ({ position, block })

type FixtureOptions = {
  readonly wrapStore?: (store: ChunkStoreApi) => ChunkStoreApi
  readonly owners?: ReadonlyArray<ReplicatedOwnerRegistration>
}

const makeFixture = (options: FixtureOptions = {}) => Effect.gen(function* () {
  const world = yield* Schema.decodeUnknownEffect(WorldIdSchema)(WORLD)
  const overworld = yield* makeChunkStore(allAirChunkSource, ChunkCapacity(16))
  const nether = yield* makeChunkStore(allAirChunkSource, ChunkCapacity(16))
  const end = yield* makeChunkStore(allAirChunkSource, ChunkCapacity(16))
  yield* overworld.load(ORIGIN_CHUNK)
  const wired = options.wrapStore === undefined ? overworld : options.wrapStore(overworld)
  const chunkStores: ChunkStoreRegistryApi = {
    forDimension: (dimension) => {
      if (dimension === 'overworld') return wired
      return dimension === 'nether' ? nether : end
    },
  }
  const coordinator = yield* makeWorldCommitCoordinator({
    world,
    owners: [{ ownerId: OWNER, schema: Schema.Number, initialState: 0 }, ...(options.owners ?? [])],
    chunkStores,
  })
  const commits = yield* Ref.make(0)
  const counted: WorldCommitCoordinatorApi = {
    ...coordinator,
    commit: (request) => Effect.andThen(Ref.update(commits, (count) => count + 1), coordinator.commit(request)),
  }
  const port: WorldWritePort['Service'] = makeWorldWritePortFromCoordinator(counted, 'overworld')
  const dirty = yield* overworld.subscribeDirty
  yield* dirty.drain

  const observeAll = Effect.gen(function* () {
    const read = yield* coordinator.observe(OWNER, Schema.Number, [
      { dimension: 'overworld', position: at(P) },
      { dimension: 'overworld', position: at(Q) },
    ])
    const chunkStoreReading = yield* overworld.getBlockWithState(at(Q))
    return {
      worldRevision: read.revision,
      owner: read.state,
      blocks: read.blocks,
      dimensionRevision: yield* coordinator.dimensionRevision('overworld'),
      chunkStoreDimensionRevision: chunkStoreReading.dimensionRevision,
    }
  })

  const currentRevisions = Effect.gen(function* () {
    return {
      world: yield* coordinator.revision,
      dimension: yield* coordinator.dimensionRevision('overworld'),
    }
  })

  // Advance only the world revision: an owner-only commit names no dimension.
  const advanceWorldOnly = coordinator.commit({
    expectedRevision: yield* coordinator.revision,
    expectedDimensions: [],
    changes: [{ ownerId: OWNER, state: 1 }],
  })

  return { world, overworld, nether, coordinator, port, commits, dirty, observeAll, currentRevisions, advanceWorldOnly }
})

// The in-memory store has no persistence and these writes target a resident
// chunk with a registered block, so a failure here is a fixture defect.
const setBlockAfterPrepare = (store: ChunkStoreApi): ChunkStoreApi => ({
  ...store,
  prepare: (edits) => Effect.tap(
    store.prepare(edits),
    () => Effect.orDie(store.setBlock(at(Q), STONE)),
  ),
})

const unloadAfterPrepare = (store: ChunkStoreApi): ChunkStoreApi => ({
  ...store,
  prepare: (edits) => Effect.tap(store.prepare(edits), () => Effect.orDie(store.unload(ORIGIN_CHUNK))),
})

const defectOf = <A, E>(exit: Exit.Exit<A, E>) => {
  expect(Exit.hasFails(exit)).toBe(false)
  const defect = Exit.findDefect(exit)
  expect(Result.isSuccess(defect)).toBe(true)
  return Result.isSuccess(defect) ? defect.success : undefined
}

describe('WorldWritePort adapter over WorldCommitCoordinator and ChunkStore', () => {
  describe('stale expected revisions', () => {
    it.effect('returns WorldWriteConflict for a stale expected world revision with the coordinator current values', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* fixture.port.applyBatch(yield* batchOf())
        const before = yield* fixture.observeAll
        yield* fixture.dirty.drain

        const error = yield* Effect.flip(fixture.port.applyBatch(yield* batchOf({
          expectedWorldRevision: 0,
          expectedDimensionRevision: 1,
          edits: [edit(Q)],
        })))

        const current = yield* fixture.currentRevisions
        expect(error).toMatchObject({
          _tag: 'WorldWriteConflict',
          expectedWorldRevision: 0,
          currentWorldRevision: 1,
          expectedDimensionRevision: 1,
          currentDimensionRevision: 1,
        })
        expect(error).toMatchObject({ currentWorldRevision: current.world, currentDimensionRevision: current.dimension })
        expect(yield* fixture.observeAll).toStrictEqual(before)
        expect(yield* fixture.dirty.drain).toEqual(EMPTY_DIRTY_BATCH)
      }))

    it.effect('reports the actual dimension revision when both expected revisions are stale', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* fixture.port.applyBatch(yield* batchOf())
        const before = yield* fixture.observeAll
        yield* fixture.dirty.drain

        const error = yield* Effect.flip(fixture.port.applyBatch(yield* batchOf({
          expectedWorldRevision: 0,
          expectedDimensionRevision: 0,
          edits: [edit(Q)],
        })))

        expect(error).toMatchObject({
          _tag: 'WorldWriteConflict',
          expectedWorldRevision: 0,
          currentWorldRevision: 1,
          expectedDimensionRevision: 0,
          currentDimensionRevision: 1,
        })
        expect(yield* fixture.observeAll).toStrictEqual(before)
        expect(yield* fixture.dirty.drain).toEqual(EMPTY_DIRTY_BATCH)
      }))

    it.effect('returns WorldWriteConflict for a stale expected dimension revision with the coordinator current values', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* fixture.port.applyBatch(yield* batchOf())
        const before = yield* fixture.observeAll
        yield* fixture.dirty.drain

        const error = yield* Effect.flip(fixture.port.applyBatch(yield* batchOf({
          expectedWorldRevision: 1,
          expectedDimensionRevision: 0,
          edits: [edit(Q)],
        })))

        const current = yield* fixture.currentRevisions
        expect(error).toMatchObject({
          _tag: 'WorldWriteConflict',
          expectedWorldRevision: 1,
          currentWorldRevision: 1,
          expectedDimensionRevision: 0,
          currentDimensionRevision: 1,
        })
        expect(error).toMatchObject({ currentWorldRevision: current.world, currentDimensionRevision: current.dimension })
        expect(yield* fixture.observeAll).toStrictEqual(before)
        expect(yield* fixture.dirty.drain).toEqual(EMPTY_DIRTY_BATCH)
      }))

    it.effect('reports the unchanged dimension revision when another commit advanced only the world', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* fixture.advanceWorldOnly
        const before = yield* fixture.observeAll

        const error = yield* Effect.flip(fixture.port.applyBatch(yield* batchOf()))

        const current = yield* fixture.currentRevisions
        expect(error).toMatchObject({
          _tag: 'WorldWriteConflict',
          expectedWorldRevision: 0,
          currentWorldRevision: 1,
          expectedDimensionRevision: 0,
          currentDimensionRevision: 0,
        })
        expect(error).toMatchObject({ currentWorldRevision: current.world, currentDimensionRevision: current.dimension })
        expect(yield* fixture.observeAll).toStrictEqual(before)
        expect(yield* fixture.dirty.drain).toEqual(EMPTY_DIRTY_BATCH)
      }))
  })

  describe('ChunkStore stale publication', () => {
    it.effect('dies on WorldWriteStale with a current chunk revision instead of reporting WorldWriteConflict', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ wrapStore: setBlockAfterPrepare })
        const before = yield* fixture.observeAll

        const exit = yield* Effect.exit(fixture.port.applyBatch(yield* batchOf()))

        expect(defectOf(exit)).toMatchObject({
          message: 'c7-adapter: unexpected WorldWriteStale',
          cause: { _tag: 'WorldWriteStale', key: '0,0', actualRevision: { _tag: 'Some' } },
        })
        const after = yield* fixture.observeAll
        expect(after.worldRevision).toBe(before.worldRevision)
        expect(after.dimensionRevision).toBe(before.dimensionRevision)
        expect(after.owner).toBe(before.owner)
        expect(after.blocks[0]).toStrictEqual(before.blocks[0])
      }))

    it.effect('keeps WorldWriteConflict and WorldWriteStale apart for the same batch', () =>
      Effect.gen(function* () {
        const stale = yield* makeFixture({ wrapStore: setBlockAfterPrepare })
        const staleExit = yield* Effect.exit(stale.port.applyBatch(yield* batchOf()))

        const conflict = yield* makeFixture()
        yield* conflict.advanceWorldOnly
        const conflictExit = yield* Effect.exit(conflict.port.applyBatch(yield* batchOf()))

        expect(Exit.hasFails(staleExit)).toBe(false)
        expect(defectOf(staleExit)).toMatchObject({ cause: { _tag: 'WorldWriteStale' } })
        expect(Exit.hasDies(conflictExit)).toBe(false)
        expect(Exit.findErrorOption(conflictExit)).toStrictEqual(Option.some(expect.objectContaining({ _tag: 'WorldWriteConflict' })))
      }))

    it.effect('returns WorldWriteChunkUnavailable when the chunk is unloaded between prepare and publish', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ wrapStore: unloadAfterPrepare })

        const error = yield* Effect.flip(fixture.port.applyBatch(yield* batchOf()))

        expect(error).toMatchObject({ _tag: 'WorldWriteChunkUnavailable', dimension: 'overworld', chunk: '0,0' })
        expect(yield* fixture.currentRevisions).toStrictEqual({ world: 0, dimension: 0 })
        expect(yield* fixture.coordinator.snapshot(OWNER, Schema.Number)).toMatchObject({ revision: 0, state: 0 })
      }))
  })

  describe('container and block atomic commits', () => {
    const containerState = (count: number) => ({
      version: 3,
      containers: [{
        id: 'overworld:1,10,1',
        kind: 'chest',
        slots: Array.from({ length: 27 }, (_, index) => index === 0
          ? { ...Result.getOrThrow(itemStackFromUnknown('apple', count)), durability: null }
          : null),
      }],
    })

    it.effect('publishes canonical container state and blocks in one adapter commit', () =>
      Effect.gen(function* () {
        const initial = yield* Schema.decodeUnknownEffect(ContainerStorageSnapshotSchema)(containerState(2))
        const next = yield* Schema.decodeUnknownEffect(ContainerStorageSnapshotSchema)(containerState(1))
        const fixture = yield* makeFixture({ owners: [containerStorageOwnerRegistration(initial)] })

        const committed = yield* commitBlockBatch(fixture.coordinator, 'overworld', yield* batchOf(), [
          { ownerId: CONTAINER_STORAGE_REPLICATED_OWNER_ID, state: next },
        ])

        expect(committed.commit).toStrictEqual({ worldRevision: 1, dimensionRevision: 1 })
        expect(committed.delta.changes).toEqual([
          expect.objectContaining({ owner: CONTAINER_STORAGE_REPLICATED_OWNER_ID, state: next }),
        ])
        expect(committed.delta.blockChanges).toEqual([
          expect.objectContaining({ position: P, before: AIR_BLOCK_ID, after: STONE }),
        ])
        expect(yield* fixture.coordinator.snapshot(CONTAINER_STORAGE_REPLICATED_OWNER_ID, ContainerStorageSnapshotSchema))
          .toMatchObject({ revision: 1, state: next })
        expect(yield* fixture.overworld.getBlock(at(P))).toStrictEqual({ _tag: 'Block', block: STONE })
        expect(yield* fixture.currentRevisions).toStrictEqual({ world: 1, dimension: 1 })
      }))

    it.effect('refuses the owner and every block edit when one target chunk is unavailable', () =>
      Effect.gen(function* () {
        const initial = yield* Schema.decodeUnknownEffect(ContainerStorageSnapshotSchema)(containerState(2))
        const next = yield* Schema.decodeUnknownEffect(ContainerStorageSnapshotSchema)(containerState(1))
        const fixture = yield* makeFixture({ owners: [containerStorageOwnerRegistration(initial)] })
        const before = yield* fixture.observeAll
        const beforeContainer = yield* fixture.coordinator.snapshot(CONTAINER_STORAGE_REPLICATED_OWNER_ID, ContainerStorageSnapshotSchema)

        const error = yield* Effect.flip(commitBlockBatch(fixture.coordinator, 'overworld', yield* batchOf({
          edits: [edit(P), edit({ x: CHUNK_SIZE_XZ + 1, y: 10, z: 1 })],
        }), [{ ownerId: CONTAINER_STORAGE_REPLICATED_OWNER_ID, state: next }]))

        expect(error).toMatchObject({ _tag: 'WorldWriteChunkUnavailable', dimension: 'overworld', chunk: '1,0' })
        expect(yield* fixture.coordinator.snapshot(CONTAINER_STORAGE_REPLICATED_OWNER_ID, ContainerStorageSnapshotSchema))
          .toStrictEqual(beforeContainer)
        expect(yield* fixture.observeAll).toStrictEqual(before)
        expect(yield* fixture.currentRevisions).toStrictEqual({ world: 0, dimension: 0 })
        expect(yield* fixture.overworld.getBlock(at(P))).toStrictEqual({ _tag: 'Block', block: AIR_BLOCK_ID })
      }))
  })

  describe('commit outcomes', () => {
    it.effect('commits a batch, writes the blocks and advances both revisions once', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()

        const committed = yield* fixture.port.applyBatch(yield* batchOf({ edits: [edit(P), edit(Q)] }))

        expect(committed).toStrictEqual({ worldRevision: 1, dimensionRevision: 1 })
        expect(committed.dimensionRevision).toBe(yield* fixture.coordinator.dimensionRevision('overworld'))
        expect(committed.worldRevision).toBe(yield* fixture.coordinator.revision)
        expect(yield* fixture.coordinator.dimensionRevision('nether')).toBe(0)
        const after = yield* fixture.observeAll
        expect(after.owner).toBe(0)
        expect(after.blocks.map(({ reading }) => reading)).toStrictEqual([
          { _tag: 'Block', block: STONE },
          { _tag: 'Block', block: STONE },
        ])
        expect(yield* Ref.get(fixture.commits)).toBe(1)
      }))

    it.effect('fails with WorldWriteChunkUnavailable when the target chunk is not resident', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const before = yield* fixture.observeAll

        const error = yield* Effect.flip(fixture.port.applyBatch(yield* batchOf({
          edits: [edit({ x: CHUNK_SIZE_XZ + 1, y: 10, z: 1 })],
        })))

        expect(error).toMatchObject({ _tag: 'WorldWriteChunkUnavailable', dimension: 'overworld', chunk: '1,0' })
        expect(yield* fixture.observeAll).toStrictEqual(before)
        expect(yield* fixture.overworld.isLoaded(chunkCoord(ChunkAxis(1), ChunkAxis(0)))).toBe(false)
      }))
  })

  describe('checks before commit', () => {
    it.effect('rejects an empty batch as WorldWriteInvalidBatch before the revisions and without committing', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const before = yield* fixture.observeAll

        const error = yield* Effect.flip(fixture.port.applyBatch(yield* batchOf({
          world: 'another-world',
          dimension: 'nether',
          expectedWorldRevision: 5,
          expectedDimensionRevision: 5,
          edits: [],
        })))

        expect(error).toMatchObject({ _tag: 'WorldWriteInvalidBatch', reason: 'empty' })
        expect(yield* Ref.get(fixture.commits)).toBe(0)
        expect(yield* fixture.observeAll).toStrictEqual(before)
      }))

    it.effect('rejects duplicate positions without committing', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()

        const error = yield* Effect.flip(fixture.port.applyBatch(yield* batchOf({
          edits: [edit(P), edit(P, AIR_BLOCK_ID)],
        })))

        expect(error).toMatchObject({ _tag: 'WorldWriteInvalidBatch', reason: 'duplicate-position' })
        expect(yield* Ref.get(fixture.commits)).toBe(0)
      }))

    it.effect('rejects a block state the block does not carry without committing', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()

        const error = yield* Effect.flip(fixture.port.applyBatch(yield* batchOf({
          edits: [{ position: P, block: STONE, state: { age: 1 } }],
        })))

        expect(error).toMatchObject({ _tag: 'WorldWriteInvalidBatch', reason: 'invalid-block-state', position: P })
        expect(yield* Ref.get(fixture.commits)).toBe(0)
      }))

    it.effect('rejects an unregistered block id as invalid-block-state without committing', () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const before = yield* fixture.observeAll

        const error = yield* Effect.flip(fixture.port.applyBatch(yield* batchOf({
          edits: [edit(Q), edit(P, UNREGISTERED_BLOCK)],
        })))

        expect(error).toMatchObject({ _tag: 'WorldWriteInvalidBatch', reason: 'invalid-block-state', position: P })
        expect(yield* Ref.get(fixture.commits)).toBe(0)
        expect(yield* fixture.observeAll).toStrictEqual(before)
      }))

    it.effect.each([
      {
        world: 'another-world', dimension: 'overworld', y: 10,
        message: 'c7-adapter: world mismatch', cause: { batch: 'another-world', coordinator: WORLD },
      },
      {
        world: WORLD, dimension: 'nether', y: 10,
        message: 'c7-adapter: dimension mismatch', cause: { batch: 'nether', port: 'overworld' },
      },
      {
        world: 'another-world', dimension: 'overworld', y: -1,
        message: 'c7-adapter: world mismatch', cause: { batch: 'another-world', coordinator: WORLD },
      },
      {
        world: WORLD, dimension: 'nether', y: CHUNK_HEIGHT,
        message: 'c7-adapter: dimension mismatch', cause: { batch: 'nether', port: 'overworld' },
      },
    ] as const)('dies on a world or dimension mismatch before height checks or commit: $world/$dimension/y=$y', ({ world, dimension, y, message, cause }) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* fixture.nether.load(ORIGIN_CHUNK)
        const foreignDirty = yield* fixture.nether.subscribeDirty
        yield* foreignDirty.drain
        const observeScope = Effect.gen(function* () {
          return {
            own: yield* fixture.observeAll,
            foreign: yield* fixture.nether.getBlockWithState(at(P)),
            foreignDimensionRevision: yield* fixture.coordinator.dimensionRevision('nether'),
          }
        })
        const before = yield* observeScope

        const exit = yield* Effect.exit(fixture.port.applyBatch(yield* batchOf({
          world, dimension, edits: [edit({ x: 1, y, z: 1 })],
        })))

        expect(defectOf(exit)).toMatchObject({ message, cause })
        expect(yield* Ref.get(fixture.commits)).toBe(0)
        expect(yield* observeScope).toStrictEqual(before)
        expect(yield* fixture.dirty.drain).toEqual(EMPTY_DIRTY_BATCH)
        expect(yield* foreignDirty.drain).toEqual(EMPTY_DIRTY_BATCH)
      }))

    it.effect.each([
      { label: 'below the world', y: -1 },
      { label: 'at CHUNK_HEIGHT', y: CHUNK_HEIGHT },
    ])('returns WorldWriteChunkUnavailable for y $label without committing', ({ y }) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const before = yield* fixture.observeAll
        const outside = { x: 1, y, z: 1 }

        const error = yield* Effect.flip(fixture.port.applyBatch(yield* batchOf({ edits: [edit(P), edit(outside)] })))

        expect(error).toMatchObject({
          _tag: 'WorldWriteChunkUnavailable',
          dimension: 'overworld',
          chunk: chunkKeyOfPosition(at(outside)),
        })
        expect(yield* Ref.get(fixture.commits)).toBe(0)
        expect(yield* fixture.observeAll).toStrictEqual(before)
      }))
  })

  describe('server adapter construction', () => {
    it.effect('builds a coordinator for the server world over the given ChunkStore registry', () =>
      Effect.gen(function* () {
        const world = yield* Schema.decodeUnknownEffect(WorldIdSchema)(WORLD)
        const overworld = yield* makeChunkStore(allAirChunkSource, ChunkCapacity(16))
        yield* overworld.load(ORIGIN_CHUNK)

        const wired = yield* makeServerWorldWrite({
          world,
          dimension: 'overworld',
          owners: [],
          chunkStores: { forDimension: () => overworld },
        })

        expect(wired.coordinator.worldId).toBe(world)
        expect(yield* wired.port.applyBatch(yield* batchOf())).toStrictEqual({ worldRevision: 1, dimensionRevision: 1 })
        expect(yield* overworld.getBlock(at(P))).toStrictEqual({ _tag: 'Block', block: STONE })
      }))
  })
})

describe('server commit deltas and codec contract', () => {
  it.effect('keeps the dimension revision distinct after an owner-only world commit', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      yield* fixture.advanceWorldOnly

      const committed = yield* fixture.port.applyBatch(yield* batchOf({
        expectedWorldRevision: 1,
        expectedDimensionRevision: 0,
      }))

      expect(committed).toStrictEqual({ worldRevision: 2, dimensionRevision: 1 })
      expect(yield* fixture.coordinator.revision).toBe(2)
      expect(yield* fixture.coordinator.dimensionRevision('overworld')).toBe(1)
      expect(yield* fixture.coordinator.snapshot(OWNER, Schema.Number)).toMatchObject({ revision: 2, state: 1 })
      expect(yield* fixture.overworld.getBlock(at(P))).toStrictEqual({ _tag: 'Block', block: STONE })
    }))

  it.effect('returns the committed delta with the same revisions and stored block', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const result = yield* commitBlockBatch(fixture.coordinator, 'overworld', yield* batchOf())
      expect(result.commit).toStrictEqual({ worldRevision: 1, dimensionRevision: 1 })
      expect(result.delta).toStrictEqual({
        world: WORLD,
        revision: 1,
        changes: [],
        blockChanges: [{ dimension: 'overworld', position: P, before: AIR_BLOCK_ID, after: STONE }],
      })
      expect(yield* fixture.overworld.getBlock(at(P))).toStrictEqual({ _tag: 'Block', block: STONE })
    }))

  it.effect.each([0, CHUNK_HEIGHT - 1])('accepts the loaded world height boundary y=%s', (y) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const position = { x: 1, y, z: 1 }
      expect(yield* fixture.port.applyBatch(yield* batchOf({ edits: [edit(position)] })))
        .toStrictEqual({ worldRevision: 1, dimensionRevision: 1 })
      expect(yield* fixture.overworld.getBlock(at(position))).toStrictEqual({ _tag: 'Block', block: STONE })
    }))

  it('returns codec-valid success or typed rejection across arbitrary edits', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        position: fc.oneof(
          fc.constant(P),
          fc.record({ x: fc.integer(), y: fc.integer(), z: fc.integer() }),
        ),
        block: fc.oneof(fc.constant(STONE), fc.constant(AIR_BLOCK_ID), fc.integer({ min: 0, max: 65535 })),
      })),
      async (edits) => {
        await Effect.runPromise(Effect.gen(function* () {
          const fixture = yield* makeFixture()
          const batch = yield* batchOf({ edits })
          const outcome = yield* Effect.result(fixture.port.applyBatch(batch))
          if (Result.isSuccess(outcome)) {
            expect(Result.isSuccess(Schema.decodeUnknownResult(WorldWriteCommitSchema)(outcome.success))).toBe(true)
            expect(outcome.success.worldRevision).toBe(yield* fixture.coordinator.revision)
            expect(outcome.success.dimensionRevision).toBe(yield* fixture.coordinator.dimensionRevision('overworld'))
          } else {
            expect(Result.isSuccess(Schema.decodeUnknownResult(Schema.Union([
              WorldWriteConflict,
              WorldWriteInvalidBatch,
              WorldWriteChunkUnavailableSchema,
            ]))(outcome.failure))).toBe(true)
            expect(yield* fixture.currentRevisions).toStrictEqual({ world: 0, dimension: 0 })
          }
        }))
      },
    ))
  })
})
