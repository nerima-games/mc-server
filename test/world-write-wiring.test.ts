import { describe, expect, it } from '@effect/vitest'
import { AIR_BLOCK_ID, BlockAxis, blockIdOf, blockPosition, WorldWriteBatchSchema, type Dimension } from '@nerima-games/mc-kernel'
import { EMPTY_DIRTY_BATCH, type ChunkStoreApi } from '@nerima-games/mc-worldgen'
import { vi } from 'vitest'
import { Effect, Exit, Option, Result, Schema } from 'effect'

import { makeMultiplayerServerCore, type MultiplayerServerCoreParts } from '../apps/multiplayer-server/core'
import { makeMultiplayerServerCoreParts } from '../apps/multiplayer-server/entrypoints/core-parts'
import { airTerrain } from './multiplayer-server/terrain'

const POSITION = { x: 1, y: 10, z: 1 }
const STONE = Option.getOrThrow(blockIdOf('stone'))
const position = blockPosition(BlockAxis(1), BlockAxis(10), BlockAxis(1))

const makeRealms = () => {
  const stores: Array<ChunkStoreApi> = []
  const realParts = makeMultiplayerServerCoreParts()
  const parts: MultiplayerServerCoreParts = {
    ...realParts,
    openChunkStore: (source) => {
      const opened = realParts.openChunkStore(source)
      stores.push(opened.store)
      return opened
    },
  }
  const configurations: ReadonlyArray<Readonly<{ worldId: string; dimension: Dimension }>> = [
    { worldId: 'server-world', dimension: 'overworld' },
    { worldId: 'nether', dimension: 'nether' },
    { worldId: 'end', dimension: 'end' },
  ]
  return configurations.map(({ worldId, dimension }, index) => {
    const core = Result.getOrThrow(makeMultiplayerServerCore({
      worldId,
      dimension,
      seed: 42,
      allowedBlocks: new Set(['stone']),
      spawnAt: { x: 0, y: 64, z: 0 },
      chunkSource: airTerrain,
      parts,
    }))
    expect(stores).toHaveLength(index + 1)
    const store = Option.getOrThrow(Option.fromUndefinedOr(stores[index]))
    Result.getOrThrow(core.readPistonCell(POSITION))
    return { core, store, worldId, dimension }
  })
}

describe('multiplayer core world write wiring', () => {
  it.effect('builds an isolated coordinator over each of the three realm ChunkStores', () =>
    Effect.gen(function* () {
      const realms = makeRealms()
      expect(new Set(realms.map(({ core }) => core.worldWrite.coordinator)).size).toBe(3)
      expect(new Set(realms.map(({ store }) => store)).size).toBe(3)

      for (const realm of realms) {
        expect(realm.core.worldWrite.coordinator.worldId).toBe(realm.worldId)
        expect(realm.core.snapshot().world).toBe(realm.worldId)
        const batch = yield* Schema.decodeUnknownEffect(WorldWriteBatchSchema)({
          world: realm.worldId,
          expectedWorldRevision: 0,
          dimension: realm.dimension,
          expectedDimensionRevision: 0,
          edits: [{ position: POSITION, block: STONE }],
        })
        expect(yield* realm.core.worldWrite.port.applyBatch(batch))
          .toStrictEqual({ worldRevision: 1, dimensionRevision: 1 })
        expect(yield* realm.store.getBlock(position)).toStrictEqual({ _tag: 'Block', block: STONE })
        expect(yield* realm.core.worldWrite.coordinator.revision).toBe(1)
        expect(yield* realm.core.worldWrite.coordinator.dimensionRevision(realm.dimension)).toBe(1)

        const uncommitted = realms.slice(realms.indexOf(realm) + 1)
        for (const other of uncommitted) {
          expect(yield* other.core.worldWrite.coordinator.revision).toBe(0)
          expect(yield* other.core.worldWrite.coordinator.dimensionRevision(other.dimension)).toBe(0)
          expect(yield* other.store.getBlock(position)).toStrictEqual({ _tag: 'Block', block: AIR_BLOCK_ID })
        }
      }
    }))

  it.effect('dies on foreign-dimension writes through each core port before commit', () =>
    Effect.gen(function* () {
      for (const realm of makeRealms()) {
        const foreignDimension = realm.dimension === 'overworld' ? 'nether' : 'overworld'
        const coordinator = realm.core.worldWrite.coordinator
        const commit = vi.spyOn(coordinator, 'commit')
        const dirty = yield* realm.store.subscribeDirty
        yield* dirty.drain
        const observe = Effect.gen(function* () {
          return {
            core: realm.core.snapshot(),
            block: yield* realm.store.getBlockWithState(position),
            worldRevision: yield* coordinator.revision,
            ownDimensionRevision: yield* coordinator.dimensionRevision(realm.dimension),
            foreignDimensionRevision: yield* coordinator.dimensionRevision(foreignDimension),
          }
        })
        const before = yield* observe
        const batch = yield* Schema.decodeUnknownEffect(WorldWriteBatchSchema)({
          world: realm.worldId,
          expectedWorldRevision: 0,
          dimension: foreignDimension,
          expectedDimensionRevision: 0,
          edits: [{ position: POSITION, block: STONE }],
        })

        const exit = yield* Effect.exit(realm.core.worldWrite.port.applyBatch(batch))

        expect(Exit.hasFails(exit)).toBe(false)
        expect(Result.getOrThrow(Exit.findDefect(exit))).toMatchObject({
          message: 'c7-adapter: dimension mismatch',
          cause: { batch: foreignDimension, port: realm.dimension },
        })
        expect(commit).not.toHaveBeenCalled()
        expect(yield* observe).toStrictEqual(before)
        expect(yield* dirty.drain).toEqual(EMPTY_DIRTY_BATCH)
        commit.mockRestore()
      }
    }))

  it('returns a typed initialization failure for an invalid world identifier', () => {
    const result = makeMultiplayerServerCore({
      worldId: '',
      seed: 42,
      allowedBlocks: new Set(['stone']),
      spawnAt: { x: 0, y: 64, z: 0 },
      chunkSource: airTerrain,
      parts: makeMultiplayerServerCoreParts(),
    })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure).toMatchObject({ _tag: 'WorldWriteInitializationFailure' })
  })
})
