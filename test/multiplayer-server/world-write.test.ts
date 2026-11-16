import { replicatedOwners } from './codec'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AIR_BLOCK_ID, BlockAxis, blockIdOf, blockPosition, ChunkAxis, chunkCoord, encodeBlockState, EncodedBlockStateSchema, PositionAxis, position, WorldWriteInvalidBatch, WorldWriteChunkUnavailableSchema } from '@nerima-games/mc-kernel'
import { makeReplicatedOwnerId, WitherChargeRemainingSecs, WitherHealthPoints } from '@nerima-games/mc-sim'
import { CHUNK_SIZE_XZ, CHUNK_VOLUME, type ChunkBiomeType, type ChunkSource, type ChunkStoreApi } from '@nerima-games/mc-worldgen'
import { AuthoritativeClientState, decodeFrame, encodeFrame, EntityId, PlayerId, PlayerName, WorldId, type NetworkMessage, type WireText } from '@nerima-games/mx-multiplayer'
import { Effect, Option, Result, Schema } from 'effect'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeMultiplayerServerCore, type MultiplayerServerCoreParts, type MultiplayerServerState } from '../../apps/multiplayer-server/core'
import type { ServerWorldWrite } from '../../apps/multiplayer-server/world-write-port'
import { makeMultiplayerServerCoreParts } from '../../apps/multiplayer-server/entrypoints/core-parts'
import { loadServerState, writeServerState } from '../../apps/multiplayer-server/main'
import { makeMultiplayerRedstoneRuntime } from '../../apps/multiplayer-server/redstone-runtime'
import { decodeAnvilWireMessage } from '../../apps/multiplayer-shared/anvil-network'
import { decodeBrewingWireMessage } from '../../apps/multiplayer-shared/brewing-network'
import { decodeCraftingWireMessage } from '../../apps/multiplayer-shared/crafting-network'
import { decodeEnchantingWireMessage } from '../../apps/multiplayer-shared/enchanting-network'
import { decodeEnderDragonWireMessage } from '../../apps/multiplayer-shared/ender-dragon-network'
import { decodePlayerDamageWireMessage } from '../../apps/multiplayer-shared/player-damage-network'
import { decodeSleepWireMessage } from '../../apps/multiplayer-shared/sleep-network'
import { decodeWitherWireMessage } from '../../apps/multiplayer-shared/wither-network'
import { airTerrain, floorTerrain, terrainFrom } from './terrain'

const WORLD = WorldId.make('commit-world')
const ALICE = PlayerId.make('alice')
const BOB = PlayerId.make('bob')
const OWNER = makeReplicatedOwnerId('test-observer')
const STONE = Option.getOrThrow(blockIdOf('stone'))
const SAND = Option.getOrThrow(blockIdOf('sand'))
const LOG = Option.getOrThrow(blockIdOf('oak_log'))
const LIT_LAMP = Option.getOrThrow(blockIdOf('redstone_lamp_lit'))
const DEFAULT_STATE = Result.getOrThrow(Schema.decodeUnknownResult(EncodedBlockStateSchema)(0))
const P = { x: 1, y: 64, z: 0 }
const at = (p: Readonly<{ x: number; y: number; z: number }>) =>
  blockPosition(BlockAxis(p.x), BlockAxis(p.y), BlockAxis(p.z))
const frame = (message: NetworkMessage): WireText => Result.getOrThrow(encodeFrame(message))
const networkMessages = (frames: ReadonlyArray<WireText>): ReadonlyArray<NetworkMessage> =>
  frames.filter((wire) => decodeSleepWireMessage(wire) === undefined
    && decodeWitherWireMessage(wire) === undefined
    && decodeEnderDragonWireMessage(wire) === undefined
    && decodePlayerDamageWireMessage(wire) === undefined
    && decodeCraftingWireMessage(wire) === undefined
    && decodeBrewingWireMessage(wire) === undefined
    && decodeAnvilWireMessage(wire) === undefined
    && decodeEnchantingWireMessage(wire) === undefined)
    .map((wire) => Result.getOrThrow(decodeFrame(wire, replicatedOwners)))

type FixtureOptions = Readonly<{
  state?: Partial<MultiplayerServerState>
  source?: ChunkSource
  dimension?: 'overworld' | 'end'
}>
const makeFixture = (options: FixtureOptions = {}) => {
  const states: Array<MultiplayerServerState> = []
  const stores: Array<ChunkStoreApi> = []
  const writes: Array<ServerWorldWrite> = []
  const realParts = makeMultiplayerServerCoreParts()
  const parts: MultiplayerServerCoreParts = {
    ...realParts,
    makeWorldWrite: (settings) => {
      const write = realParts.makeWorldWrite({
        ...settings,
        owners: [...settings.owners, { ownerId: OWNER, schema: Schema.Number, initialState: 0 }],
      })
      if (Result.isSuccess(write)) writes.push(write.success)
      return write
    },
    openChunkStore: (source) => {
      const opened = realParts.openChunkStore(source)
      stores.push(opened.store)
      return opened
    },
  }
  const core = Result.getOrThrow(makeMultiplayerServerCore({
    worldId: WORLD,
    dimension: options.dimension ?? 'overworld',
    seed: 42,
    allowedBlocks: new Set(['stone', 'sand', 'gravel', 'redstone_lamp', 'oak_log', 'tnt']),
    chunkSource: options.source === undefined ? airTerrain : options.source,
    parts,
    spawnAt: { x: 0, y: 64, z: 0 },
    initialState: {
      revision: 0,
      blocks: [],
      inventories: [
        { player: ALICE, state: { slots: [{ item: 'stone', count: 16 }, null], selectedSlot: 0 } },
        { player: BOB, state: { slots: [{ item: 'stone', count: 16 }, null], selectedSlot: 0 } },
      ],
      vitals: [],
      timeWeather: { timeOfDay: 6000, weather: 'clear' },
      containers: [],
      furnaces: [],
      villagerTrades: [],
      ...options.state,
    },
    onStateChanged: (state) => states.push(state),
  }))
  const store = Option.getOrThrow(Option.fromUndefinedOr(stores[0]))
  const worldWrite = Option.getOrThrow(Option.fromUndefinedOr(writes[0]))
  const alice: Array<WireText> = []
  const bob: Array<WireText> = []
  for (const [client, player, output] of [
    ['alice-socket', ALICE, alice],
    ['bob-socket', BOB, bob],
  ] as const) {
    expect(core.connect(client, (wire) => output.push(wire))).toBe(true)
    expect(core.receive(client, frame({
      _tag: 'PlayerJoin', player, name: PlayerName.make(player), at: { x: 0, y: 64, z: 0 },
    })).accepted).toBe(true)
  }
  const initialAlice = [...alice]
  alice.length = 0
  bob.length = 0
  const receive = (message: NetworkMessage) => core.receive('alice-socket', frame(message))
  const place = (position = P) => receive({
    _tag: 'BlockPlace', player: ALICE, world: WORLD, at: position, block: 'stone', state: DEFAULT_STATE,
  })
  const breakBlock = (position = P) => receive({ _tag: 'BlockBreak', player: ALICE, world: WORLD, at: position })
  const lastState = () => Option.getOrThrow(Option.fromUndefinedOr(states.at(-1)))
  const freshSnapshot = () => {
    const start = alice.length
    expect(receive({ _tag: 'AuthoritativeResyncRequest', world: WORLD }).accepted).toBe(true)
    return Option.getOrThrow(Option.fromUndefinedOr(networkMessages(alice.slice(start))
      .find((message) => message._tag === 'AuthoritativeSnapshot')))
  }
  const deltas = (output: ReadonlyArray<WireText>) =>
    networkMessages(output).filter((message) => message._tag === 'ReplicatedWorldDelta')
  return { core, parts, worldWrite, store, states, alice, bob, initialAlice, receive, place, breakBlock, lastState, freshSnapshot, deltas }
}

const makeBoundaryExplosion = (dimension: 'overworld' | 'end' = 'overworld', chargeRemainingSecs = 0.05) => {
  const loaded: Array<string> = []
  const terrain = terrainFrom(({ x, y, z }) =>
    y === 63 || ((x === 15 || x === 16) && y === 64 && z === 0) ? 'stone' : null)
  const source: ChunkSource = (coord) => {
    loaded.push(`${String(coord.cx)},${String(coord.cz)}`)
    return terrain(coord)
  }
  const center = { x: 15, y: 64, z: 0 }
  const untouched = { x: 16, y: 64, z: 0 }
  const fixture = makeFixture({ source, dimension, state: { wither: {
    nextWitherId: 1,
    nextSkullId: 0,
    withers: [{
      id: 'wither-1',
      dimension: WORLD,
      snapshot: {
        kind: 'wither',
        version: 1,
        state: {
          phase: 'charging',
          healthPoints: WitherHealthPoints(300),
          chargeRemainingSecs: WitherChargeRemainingSecs(chargeRemainingSecs),
          feetPosition: position(PositionAxis(15), PositionAxis(64), PositionAxis(0)),
          velocity: position(PositionAxis(0), PositionAxis(0), PositionAxis(0)),
        },
      },
      rangedCooldownSecs: 100,
      meleeCooldownSecs: 0,
      shotsFired: 0,
    }],
    skulls: [],
  } } })
  Result.getOrThrow(fixture.core.readPistonCell(center))
  return { fixture, loaded, center, untouched, terrain }
}

describe('coordinator-backed multiplayer block writes', () => {
  afterEach(() => vi.restoreAllMocks())
  it('establishes a coordinator revision baseline that the real client reducer accepts before deltas and resync', () => {
    const fixture = makeFixture({ state: { revision: 9 } })
    const joined = networkMessages(fixture.initialAlice)
    expect(joined).toContainEqual(expect.objectContaining({ _tag: 'WorldSnapshot', revision: 9 }))
    const baseline = Option.getOrThrow(Option.fromUndefinedOr(
      joined.find((message) => message._tag === 'ReplicatedWorldSnapshot'),
    ))
    expect(baseline).toMatchObject({ world: WORLD, revision: 0 })
    const client = new AuthoritativeClientState()
    expect(client.applySnapshot(baseline).accepted).toBe(true)

    expect(fixture.place().accepted).toBe(true)
    const delta = Option.getOrThrow(Option.fromUndefinedOr(fixture.deltas(fixture.alice)[0]))
    expect(delta.revision).toBe(1)
    expect(client.applyDelta(delta).accepted).toBe(true)
    const world = Option.getOrThrow(Option.fromUndefinedOr(client.world(WORLD)))
    expect(world.revision).toBe(1)
    expect([...world.blocks.values()]).toContainEqual({
      dimension: 'overworld', position: P, reading: { _tag: 'Block', block: STONE }, state: DEFAULT_STATE,
    })
    expect(fixture.core.snapshot().revision).toBeGreaterThan(1)

    fixture.alice.length = 0
    expect(fixture.receive({ _tag: 'AuthoritativeResyncRequest', world: WORLD }).accepted).toBe(true)
    const resync = Option.getOrThrow(Option.fromUndefinedOr(
      networkMessages(fixture.alice).find((message) => message._tag === 'ReplicatedWorldSnapshot'),
    ))
    expect(resync).toMatchObject({
      world: WORLD,
      revision: 1,
      blocks: expect.arrayContaining([{
        dimension: 'overworld', position: P, reading: { _tag: 'Block', block: STONE }, state: DEFAULT_STATE,
      }]),
    })
    expect(new AuthoritativeClientState().applySnapshot(resync).accepted).toBe(true)
  })

  it('publishes placement and break deltas to every peer with stored blocks and coordinator revisions', () => {
    const fixture = makeFixture()
    expect(fixture.place().accepted).toBe(true)
    const placed = {
      _tag: 'ReplicatedWorldDelta', world: WORLD, revision: 1, changes: [],
      blockChanges: [{ dimension: 'overworld', position: P, before: AIR_BLOCK_ID, after: STONE, beforeState: DEFAULT_STATE, afterState: DEFAULT_STATE }],
    }
    expect(fixture.deltas(fixture.alice)).toStrictEqual([placed])
    expect(fixture.deltas(fixture.bob)).toStrictEqual([placed])
    expect(Effect.runSync(fixture.store.getBlock(at(P)))).toStrictEqual({ _tag: 'Block', block: STONE })
    expect(Effect.runSync(fixture.worldWrite.coordinator.revision)).toBe(1)
    expect(Effect.runSync(fixture.worldWrite.coordinator.dimensionRevision('overworld'))).toBe(1)

    fixture.alice.length = 0
    fixture.bob.length = 0
    expect(fixture.breakBlock().accepted).toBe(true)
    const broken = {
      _tag: 'ReplicatedWorldDelta', world: WORLD, revision: 2, changes: [],
      blockChanges: [{ dimension: 'overworld', position: P, before: STONE, after: AIR_BLOCK_ID, beforeState: DEFAULT_STATE, afterState: DEFAULT_STATE }],
    }
    expect(fixture.deltas(fixture.alice)).toStrictEqual([broken])
    expect(fixture.deltas(fixture.bob)).toStrictEqual([broken])
    expect(Effect.runSync(fixture.store.getBlock(at(P)))).toStrictEqual({ _tag: 'Block', block: AIR_BLOCK_ID })
    expect(Effect.runSync(fixture.worldWrite.coordinator.revision)).toBe(2)
    expect(Effect.runSync(fixture.worldWrite.coordinator.dimensionRevision('overworld'))).toBe(2)
    expect(networkMessages(fixture.alice).some(({ _tag }) => _tag === 'BlockPlace' || _tag === 'BlockBreak')).toBe(false)
    expect(networkMessages(fixture.bob).some(({ _tag }) => _tag === 'BlockPlace' || _tag === 'BlockBreak')).toBe(false)
  })

  it('notifies only the sender when a real intervening coordinator commit makes placement stale', () => {
    const fixture = makeFixture()
    const beforeInventory = fixture.lastState().inventories
    const beforeBlocks = fixture.core.snapshot().blocks
    const coordinator = fixture.worldWrite.coordinator
    const originalCommit = coordinator.commit
    const commit = vi.spyOn(coordinator, 'commit').mockImplementationOnce((request) => Effect.gen(function* () {
      yield* originalCommit({
        expectedRevision: request.expectedRevision,
        expectedDimensions: [],
        changes: [{ ownerId: OWNER, state: 1 }],
      })
      return yield* originalCommit(request)
    }))

    expect(fixture.place()).toMatchObject({
      accepted: false,
      reason: 'invalid-mutation',
      failure: {
        _tag: 'WorldWriteFailure',
        failure: { _tag: 'WorldWriteConflict', expectedWorldRevision: 0, currentWorldRevision: 1 },
      },
    })

    expect(networkMessages(fixture.alice)).toEqual([
      expect.objectContaining({ _tag: 'BlockMutationRejected', operation: 'place', reason: 'stale-revision', revision: 1 }),
    ])
    expect(fixture.bob).toEqual([])
    expect(fixture.core.snapshot().blocks).toStrictEqual(beforeBlocks)
    fixture.alice.length = 0
    expect(fixture.receive({ _tag: 'AuthoritativeResyncRequest', world: WORLD }).accepted).toBe(true)
    const freshSnapshots = networkMessages(fixture.alice).filter((message) => message._tag === 'AuthoritativeSnapshot')
    expect(freshSnapshots).toHaveLength(1)
    expect(freshSnapshots[0]?.inventories).toStrictEqual(beforeInventory)
    expect(freshSnapshots[0]?.inventories).toContainEqual(expect.objectContaining({
      player: ALICE, state: expect.objectContaining({ slots: [{ item: 'stone', count: 16 }, null] }),
    }))
    expect(Effect.runSync(coordinator.revision)).toBe(1)
    expect(Effect.runSync(coordinator.dimensionRevision('overworld'))).toBe(0)
    expect(Effect.runSync(coordinator.snapshot(OWNER, Schema.Number))).toMatchObject({ revision: 1, state: 1 })
    expect(Effect.runSync(fixture.store.getBlock(at(P)))).toStrictEqual({ _tag: 'Block', block: AIR_BLOCK_ID })
    expect(commit).toHaveBeenCalledOnce()
    commit.mockRestore()
  })

  it.each([-1, 256])('rejects y=%s before invoking the block coordinator', (y) => {
    const fixture = makeFixture()
    const commit = vi.spyOn(fixture.worldWrite.coordinator, 'commit')
    const before = fixture.lastState()
    expect(fixture.place({ x: 0, y, z: 0 })).toEqual({ accepted: false, reason: 'invalid-mutation' })
    expect(networkMessages(fixture.alice)).toEqual([
      expect.objectContaining({ _tag: 'BlockMutationRejected', reason: 'out-of-bounds', revision: 0 }),
    ])
    expect(fixture.bob).toEqual([])
    expect(fixture.lastState()).toStrictEqual(before)
    expect(commit).not.toHaveBeenCalled()
    commit.mockRestore()
  })

  it('commits repeated writes in one resident chunk without reloading or losing earlier edits', () => {
    const fixture = makeFixture()
    expect(fixture.place().accepted).toBe(true)
    const firstChunk = Effect.runSync(fixture.store.peek(chunkCoord(ChunkAxis(0), ChunkAxis(0))))
    expect(fixture.place({ x: 2, y: 64, z: 0 }).accepted).toBe(true)
    expect(fixture.breakBlock().accepted).toBe(true)
    expect(fixture.place().accepted).toBe(true)
    expect(fixture.deltas(fixture.bob).map(({ revision }) => revision)).toEqual([1, 2, 3, 4])
    expect(Effect.runSync(fixture.store.isLoaded(chunkCoord(ChunkAxis(0), ChunkAxis(0))))).toBe(true)
    expect(firstChunk).toBeDefined()
    expect(Effect.runSync(fixture.store.getBlock(at(P)))).toStrictEqual({ _tag: 'Block', block: STONE })
    expect(Effect.runSync(fixture.store.getBlock(at({ x: 2, y: 64, z: 0 })))).toStrictEqual({ _tag: 'Block', block: STONE })
    expect(Effect.runSync(fixture.worldWrite.coordinator.revision)).toBe(4)
  })

  it('restores committed edits after ChunkStore eviction and a state-file round trip', async () => {
    const source: ChunkSource = (coord) => Effect.succeed({
      coord,
      blocks: new Uint16Array(CHUNK_VOLUME).fill(AIR_BLOCK_ID),
      biomes: Array.from({ length: CHUNK_SIZE_XZ * CHUNK_SIZE_XZ }, (): ChunkBiomeType => 'PLAINS'),
    })
    const fixture = makeFixture({ source, state: { inventories: [{
      player: ALICE, state: { slots: [{ item: 'oak_log', count: 2 }], selectedSlot: 0 },
    }] } })
    expect(fixture.receive({
      _tag: 'BlockPlace', player: ALICE, world: WORLD, at: P, block: 'oak_log',
      state: Result.getOrThrow(encodeBlockState(LOG, { axis: 'x' })),
    }).accepted).toBe(true)
    for (let chunk = 1; chunk <= 256; chunk += 1) {
      Result.getOrThrow(fixture.core.readPistonCell({ x: chunk * CHUNK_SIZE_XZ, y: 64, z: 0 }))
    }
    expect(Effect.runSync(fixture.store.isLoaded(chunkCoord(ChunkAxis(0), ChunkAxis(0))))).toBe(false)
    Result.getOrThrow(fixture.core.readPistonCell(P))
    expect(Effect.runSync(fixture.store.getBlockWithState(at(P)))).toMatchObject({
      _tag: 'Block', block: LOG, state: { axis: 'x' },
    })

    const file = join(await mkdtemp(join(tmpdir(), 'server-world-write-')), 'state.json')
    await writeServerState(file, WORLD, 42, fixture.lastState())
    const loaded = Result.getOrThrow(await loadServerState(file, WORLD, 42))
    expect(loaded).toBeDefined()
    const restored = makeFixture({ state: Option.getOrThrow(Option.fromUndefinedOr(loaded)) })
    Result.getOrThrow(restored.core.readPistonCell(P))
    expect(Effect.runSync(restored.store.getBlockWithState(at(P)))).toMatchObject({
      _tag: 'Block', block: LOG, state: { axis: 'x' },
    })
    expect(restored.core.snapshot().blocks).toContainEqual(expect.objectContaining({ world: WORLD, at: P, block: 'oak_log' }))
  })

  it('commits falling sand as one batch after its support is broken', () => {
    const fixture = makeFixture({
      source: floorTerrain(63, 'stone'),
      state: { blocks: [{ at: P, block: 'stone' }, { at: { x: 1, y: 65, z: 0 }, block: 'sand' }] },
    })
    expect(fixture.breakBlock().accepted).toBe(true)
    fixture.alice.length = 0
    fixture.bob.length = 0
    const before = Effect.runSync(fixture.worldWrite.coordinator.revision)
    expect(Result.isSuccess(fixture.core.tick(50))).toBe(true)
    const deltas = fixture.deltas(fixture.bob)
    expect(deltas).toContainEqual(expect.objectContaining({
      revision: before + 1,
      blockChanges: expect.arrayContaining([
        expect.objectContaining({ position: { x: 1, y: 65, z: 0 }, before: SAND, after: AIR_BLOCK_ID }),
        expect.objectContaining({ position: P, before: AIR_BLOCK_ID, after: SAND }),
      ]),
    }))
    expect(Effect.runSync(fixture.store.getBlock(at(P)))).toStrictEqual({ _tag: 'Block', block: SAND })
    expect(Effect.runSync(fixture.worldWrite.coordinator.revision)).toBe(before + 1)
  })

  it('discards a failed falling batch, runs later item aging in the same tick, and never retries it', () => {
    const drop = EntityId.make('expiring-drop')
    const fixture = makeFixture({
      source: floorTerrain(63, 'stone'),
      state: {
        blocks: [{ at: P, block: 'stone' }, { at: { x: 1, y: 65, z: 0 }, block: 'sand' }],
        entities: [{ _tag: 'item-drop', entityId: drop, at: { x: 7, y: 65, z: 7 }, stack: { item: 'stone', count: 1 }, ageTicks: 5_999 }],
      },
    })
    expect(fixture.breakBlock().accepted).toBe(true)
    fixture.alice.length = 0
    fixture.bob.length = 0
    const beforeBlocks = fixture.core.snapshot().blocks
    const unavailable = Result.getOrThrow(Schema.decodeUnknownResult(WorldWriteChunkUnavailableSchema)({
      _tag: 'WorldWriteChunkUnavailable', dimension: 'overworld', chunk: '0,0',
    }))
    const commit = vi.spyOn(fixture.worldWrite.coordinator, 'commit').mockImplementationOnce(() => Effect.fail(unavailable))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(Result.isSuccess(fixture.core.tick(50))).toBe(true)
    expect(Option.getOrThrow(Option.fromUndefinedOr(fixture.freshSnapshot().entities)).some(({ entityId }) => entityId === drop)).toBe(false)
    expect(networkMessages(fixture.bob)).toContainEqual(expect.objectContaining({ _tag: 'EntityDespawnDelta', entityId: drop }))
    expect(fixture.core.snapshot().blocks).toStrictEqual(beforeBlocks)
    expect(Effect.runSync(fixture.store.getBlock(at(P)))).toStrictEqual({ _tag: 'Block', block: AIR_BLOCK_ID })
    expect(Effect.runSync(fixture.store.getBlock(at({ x: 1, y: 65, z: 0 })))).toStrictEqual({ _tag: 'Block', block: SAND })
    expect(fixture.deltas(fixture.bob)).toEqual([])
    expect(Effect.runSync(fixture.worldWrite.coordinator.revision)).toBe(1)
    expect(logged).toHaveBeenCalledExactlyOnceWith('Multiplayer falling block batch discarded', { worldId: WORLD, failure: unavailable })
    expect(commit).toHaveBeenCalledOnce()
    expect(Result.isSuccess(fixture.core.tick(50))).toBe(true)
    expect(commit).toHaveBeenCalledOnce()
    expect(fixture.deltas(fixture.bob)).toEqual([])
    logged.mockRestore()
    commit.mockRestore()
  })

  const impossibleBatchReasons: ReadonlyArray<'empty' | 'duplicate-position'> = ['empty', 'duplicate-position']
  it.each(impossibleBatchReasons)('treats impossible %s player batches as defects without changing state', (reason) => {
    const fixture = makeFixture()
    const beforeBlocks = fixture.core.snapshot().blocks
    const beforeInventory = fixture.lastState().inventories
    const failure = Result.getOrThrow(Schema.decodeUnknownResult(WorldWriteInvalidBatch)({ _tag: 'WorldWriteInvalidBatch', reason }))
    const commit = vi.spyOn(fixture.worldWrite.coordinator, 'commit')
    const injected = vi.spyOn(fixture.parts, 'commitWorldWrite').mockReturnValueOnce(Result.fail(failure))
    expect(() => fixture.place()).toThrow('c7-adapter: unexpected WorldWriteInvalidBatch')
    expect(injected).toHaveBeenCalledOnce()
    expect(commit).not.toHaveBeenCalled()
    expect(fixture.core.snapshot().blocks).toStrictEqual(beforeBlocks)
    expect(Effect.runSync(fixture.worldWrite.coordinator.revision)).toBe(0)
    expect(Effect.runSync(fixture.worldWrite.coordinator.dimensionRevision('overworld'))).toBe(0)
    expect(fixture.deltas(fixture.bob)).toEqual([])
    fixture.alice.length = 0
    expect(fixture.receive({ _tag: 'AuthoritativeResyncRequest', world: WORLD }).accepted).toBe(true)
    const fresh = networkMessages(fixture.alice).filter((message) => message._tag === 'AuthoritativeSnapshot')
    expect(fresh).toHaveLength(1)
    expect(fresh[0]?.inventories).toStrictEqual(beforeInventory)
    expect(Effect.runSync(fixture.store.getBlock(at(P)))).toStrictEqual({ _tag: 'Block', block: AIR_BLOCK_ID })
    injected.mockRestore()
    commit.mockRestore()
  })

  it('maps an invalid block state to unknown-block without changing inventory or blocks', () => {
    const fixture = makeFixture()
    const beforeInventory = fixture.lastState().inventories
    const failure = Result.getOrThrow(Schema.decodeUnknownResult(WorldWriteInvalidBatch)({
      _tag: 'WorldWriteInvalidBatch', reason: 'invalid-block-state', position: P,
    }))
    const injected = vi.spyOn(fixture.parts, 'commitWorldWrite').mockReturnValueOnce(Result.fail(failure))
    const commit = vi.spyOn(fixture.worldWrite.coordinator, 'commit')
    expect(fixture.place()).toMatchObject({ accepted: false, failure: { _tag: 'WorldWriteFailure', failure } })
    expect(networkMessages(fixture.alice)).toEqual([
      expect.objectContaining({ _tag: 'BlockMutationRejected', reason: 'unknown-block', revision: 0 }),
    ])
    expect(fixture.bob).toEqual([])
    expect(commit).not.toHaveBeenCalled()
    expect(Effect.runSync(fixture.worldWrite.coordinator.revision)).toBe(0)
    expect(Effect.runSync(fixture.store.getBlock(at(P)))).toStrictEqual({ _tag: 'Block', block: AIR_BLOCK_ID })
    fixture.alice.length = 0
    expect(fixture.receive({ _tag: 'AuthoritativeResyncRequest', world: WORLD }).accepted).toBe(true)
    const fresh = networkMessages(fixture.alice).filter((message) => message._tag === 'AuthoritativeSnapshot')
    expect(fresh).toHaveLength(1)
    expect(fresh[0]?.inventories).toStrictEqual(beforeInventory)
    injected.mockRestore()
    commit.mockRestore()
  })

  const redstoneFailures: ReadonlyArray<Readonly<{
    block: 'redstone_lamp' | 'door' | 'piston'
    after: 'redstone_lamp_lit' | 'door_open' | 'piston_head'
  }>> = [
    { block: 'redstone_lamp', after: 'redstone_lamp_lit' },
    { block: 'door', after: 'door_open' },
    { block: 'piston', after: 'piston_head' },
  ]
  it.each(redstoneFailures)('logs a failed $block event and commits the later event in the same real redstone tick', async ({ block, after }) => {
    const other = { x: 5, y: 64, z: 0 }
    const fixture = makeFixture({ state: { blocks: [
      { at: { x: 0, y: 64, z: 0 }, block: 'redstone_torch' },
      { at: { x: 4, y: 64, z: 0 }, block: 'redstone_torch' },
      { at: P, block }, { at: other, block },
      ...(block === 'piston' ? [
        { at: { ...P, z: -1 }, block: 'stone' }, { at: { ...other, z: -1 }, block: 'stone' },
      ] : []),
    ] } })
    const unavailable = Result.getOrThrow(Schema.decodeUnknownResult(WorldWriteChunkUnavailableSchema)({
      _tag: 'WorldWriteChunkUnavailable', dimension: 'overworld', chunk: '0,0',
    }))
    const commit = vi.spyOn(fixture.worldWrite.coordinator, 'commit').mockImplementationOnce(() => Effect.fail(unavailable))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const runtime = await makeMultiplayerRedstoneRuntime([{ dimension: 'overworld', core: fixture.core }])
    expect(await Effect.runPromise(runtime.tick(100))).toEqual(Result.succeed(undefined))
    expect(commit).toHaveBeenCalledTimes(2)
    expect(logged).toHaveBeenCalledExactlyOnceWith('Multiplayer redstone block write failed', {
      dimension: 'overworld', position: expect.any(Object),
      failure: { _tag: 'WorldWriteFailure', failure: unavailable },
    })
    const cells = [P, other].map((cell) => Effect.runSync(fixture.store.getBlock(at(block === 'piston' ? { ...cell, z: -1 } : cell))))
    expect(cells).toContainEqual({ _tag: 'Block', block: Option.getOrThrow(blockIdOf(block === 'piston' ? 'stone' : block)) })
    expect(cells).toContainEqual({ _tag: 'Block', block: Option.getOrThrow(blockIdOf(after)) })
    expect(fixture.deltas(fixture.bob)).toHaveLength(1)
    expect(Effect.runSync(fixture.worldWrite.coordinator.revision)).toBe(1)
    expect(await Effect.runPromise(runtime.tick(100))).toEqual(Result.succeed(undefined))
    expect(commit).toHaveBeenCalledTimes(2)
    logged.mockRestore()
    commit.mockRestore()
  })

  it('commits redstone lamp state through the redstone runtime and broadcasts its block delta', async () => {
    const fixture = makeFixture({ state: { blocks: [
      { at: { x: 0, y: 64, z: 0 }, block: 'redstone_torch' },
      { at: P, block: 'redstone_lamp' },
    ] } })
    const runtime = await makeMultiplayerRedstoneRuntime([{ dimension: 'overworld', core: fixture.core }])
    expect(Result.isSuccess(await Effect.runPromise(runtime.tick(100)))).toBe(true)
    expect(fixture.deltas(fixture.bob)).toContainEqual(expect.objectContaining({
      revision: 1,
      blockChanges: expect.arrayContaining([expect.objectContaining({ position: P, after: LIT_LAMP })]),
    }))
    expect(Effect.runSync(fixture.store.getBlock(at(P)))).toStrictEqual({ _tag: 'Block', block: LIT_LAMP })
    expect(Effect.runSync(fixture.worldWrite.coordinator.revision)).toBe(1)
  })

  it('retains door facing, half and hinge when redstone opens it', async () => {
    const doorOpen = Option.getOrThrow(blockIdOf('door_open'))
    const state = { facing: 'east', half: 'upper', hinge: 'right' } as const
    const fixture = makeFixture({ state: { blocks: [
      { at: { x: 0, y: 64, z: 0 }, block: 'redstone_torch' },
      { at: P, block: 'door', state },
    ] } })
    const runtime = await makeMultiplayerRedstoneRuntime([{ dimension: 'overworld', core: fixture.core }])

    expect(await Effect.runPromise(runtime.tick(100))).toEqual(Result.succeed(undefined))

    expect(Effect.runSync(fixture.store.getBlockWithState(at(P)))).toMatchObject({
      _tag: 'Block', block: doorOpen, state,
    })
    expect(fixture.deltas(fixture.bob)).toContainEqual(expect.objectContaining({
      blockChanges: expect.arrayContaining([expect.objectContaining({
        position: P,
        after: doorOpen,
        afterState: Result.getOrThrow(encodeBlockState(doorOpen, state)),
      })]),
    }))
    expect(Effect.runSync(fixture.worldWrite.coordinator.revision)).toBe(1)
  })

  it('moves a placed stateful block through one piston batch without resetting its state', async () => {
    const moved = { x: 1, y: 64, z: -1 }
    const destination = { x: 1, y: 64, z: -2 }
    const fixture = makeFixture({ state: {
      blocks: [
        { at: { x: 0, y: 64, z: 0 }, block: 'redstone_torch' },
        { at: P, block: 'piston' },
      ],
      inventories: [{ player: ALICE, state: { slots: [{ item: 'oak_log', count: 2 }], selectedSlot: 0 } }],
    } })
    expect(fixture.receive({
      _tag: 'BlockPlace', player: ALICE, world: WORLD, at: moved, block: 'oak_log',
      state: Result.getOrThrow(encodeBlockState(LOG, { axis: 'x' })),
    }).accepted).toBe(true)
    fixture.alice.length = 0
    fixture.bob.length = 0
    const runtime = await makeMultiplayerRedstoneRuntime([{ dimension: 'overworld', core: fixture.core }])
    expect(Result.isSuccess(await Effect.runPromise(runtime.tick(100)))).toBe(true)
    const deltas = fixture.deltas(fixture.bob)
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({
      revision: 2,
      blockChanges: expect.arrayContaining([expect.objectContaining({
        position: destination, after: LOG, afterState: Result.getOrThrow(encodeBlockState(LOG, { axis: 'x' })),
      })]),
    })
    expect(Effect.runSync(fixture.store.getBlockWithState(at(destination)))).toMatchObject({
      _tag: 'Block', block: LOG, state: { axis: 'x' },
    })
    expect(Effect.runSync(fixture.worldWrite.coordinator.revision)).toBe(2)
  })

  it('commits explosion damage and publishes the changed blocks without altering distant edits', () => {
    const fixture = makeFixture({ state: {
      blocks: [{ at: P, block: 'stone' }, { at: { x: 17, y: 64, z: 0 }, block: 'stone' }],
      entities: [{
        _tag: 'living', entityId: EntityId.make('creeper-test'),
        entityType: 'creeper', at: { x: 1, y: 64, z: 1 }, health: 20, maxHealth: 20,
      }],
    } })
    Result.getOrThrow(fixture.core.readPistonCell(P))
    expect(Effect.runSync(fixture.store.isLoaded(chunkCoord(ChunkAxis(1), ChunkAxis(0))))).toBe(false)
    expect(Result.isSuccess(fixture.core.tick(1000))).toBe(true)
    expect(Result.isSuccess(fixture.core.tick(600))).toBe(true)
    expect(fixture.deltas(fixture.bob).some(({ blockChanges }) => blockChanges.some(({ position }) =>
      position.x === P.x && position.y === P.y && position.z === P.z))).toBe(true)
    expect(Effect.runSync(fixture.store.getBlock(at(P)))).toStrictEqual({ _tag: 'Block', block: AIR_BLOCK_ID })
    expect(fixture.core.snapshot().blocks).toContainEqual({ world: WORLD, at: { x: 17, y: 64, z: 0 }, block: 'stone' })
  })

  it('does not load or edit the adjacent unloaded chunk while planning a boundary explosion', () => {
    const { fixture, loaded, center, untouched, terrain } = makeBoundaryExplosion()
    const controlLoads: Array<string> = []
    const control = makeFixture({ source: (coord) => {
      controlLoads.push(`${String(coord.cx)},${String(coord.cz)}`)
      return terrain(coord)
    } })
    Result.getOrThrow(control.core.readPistonCell(center))
    expect(loaded).toEqual(['0,0'])
    expect(Effect.runSync(fixture.store.isLoaded(chunkCoord(ChunkAxis(1), ChunkAxis(0))))).toBe(false)

    expect(Result.isSuccess(control.core.tick(100))).toBe(true)
    expect(Result.isSuccess(fixture.core.tick(100))).toBe(true)

    expect(loaded).toEqual(controlLoads)
    expect(loaded).not.toContain('1,0')
    expect(Effect.runSync(fixture.store.isLoaded(chunkCoord(ChunkAxis(1), ChunkAxis(0))))).toBe(false)
    expect(fixture.deltas(fixture.bob)).toContainEqual(expect.objectContaining({
      blockChanges: expect.arrayContaining([expect.objectContaining({
        position: center, before: STONE, after: AIR_BLOCK_ID,
      })]),
    }))
    Result.getOrThrow(fixture.core.readPistonCell(untouched))
    expect(Effect.runSync(fixture.store.getBlock(at(untouched)))).toStrictEqual({ _tag: 'Block', block: STONE })
  })

  it('discards a failed TNT explosion and still advances the later wither step without retrying TNT', () => {
    const boundary = makeBoundaryExplosion('overworld', 5)
    const initial = boundary.fixture.lastState()
    const tnt = EntityId.make('failed-explosion')
    const fixture = makeFixture({ source: floorTerrain(63, 'stone'), state: {
      ...initial,
      blocks: [{ at: P, block: 'stone' }],
      entities: [
        { _tag: 'primed-tnt', entityId: tnt, at: { x: 1.5, y: 64, z: 0.5 }, burnedSecs: 3.99, owner: null },
        { _tag: 'arrow', entityId: EntityId.make('unrelated-arrow'), at: { x: 5, y: 100, z: 5 },
          velocity: { x: 10, y: 0, z: 0 }, damage: 2, owner: null, ageTicks: 0 },
      ],
    } })
    Result.getOrThrow(fixture.core.readPistonCell(P))
    const beforeBlocks = fixture.core.snapshot().blocks
    const beforeWither = fixture.lastState().wither
    const unavailable = Result.getOrThrow(Schema.decodeUnknownResult(WorldWriteChunkUnavailableSchema)({
      _tag: 'WorldWriteChunkUnavailable', dimension: 'overworld', chunk: '0,0',
    }))
    const commit = vi.spyOn(fixture.worldWrite.coordinator, 'commit').mockImplementationOnce(() => Effect.fail(unavailable))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(Result.isSuccess(fixture.core.tick(100))).toBe(true)
    expect(Option.getOrThrow(Option.fromUndefinedOr(fixture.freshSnapshot().entities)).some(({ entityId }) => entityId === tnt)).toBe(false)
    expect(fixture.freshSnapshot().entities).toContainEqual(expect.objectContaining({
      _tag: 'arrow', entityId: EntityId.make('unrelated-arrow'), at: expect.objectContaining({ x: 6 }),
    }))
    expect(fixture.lastState().wither).not.toStrictEqual(beforeWither)
    expect(fixture.lastState().wither?.withers[0]?.snapshot.state).toMatchObject({ phase: 'charging', chargeRemainingSecs: 4.9 })
    expect(fixture.core.snapshot().blocks).toStrictEqual(beforeBlocks)
    expect(Effect.runSync(fixture.store.getBlock(at(P)))).toStrictEqual({ _tag: 'Block', block: STONE })
    expect(fixture.deltas(fixture.bob)).toEqual([])
    expect(Effect.runSync(fixture.worldWrite.coordinator.revision)).toBe(0)
    expect(logged).toHaveBeenCalledExactlyOnceWith('Multiplayer entity block batch discarded', { worldId: WORLD, failure: unavailable })
    expect(Result.isSuccess(fixture.core.tick(100))).toBe(true)
    expect(commit).toHaveBeenCalledOnce()
    expect(fixture.deltas(fixture.bob)).toEqual([])
    logged.mockRestore()
    commit.mockRestore()
  })

  it('discards a failed wither explosion and runs the later ender dragon step without retrying the explosion', () => {
    const { fixture, center } = makeBoundaryExplosion('end')
    const beforeBlocks = fixture.core.snapshot().blocks
    const beforeWither = fixture.lastState().wither
    const unavailable = Result.getOrThrow(Schema.decodeUnknownResult(WorldWriteChunkUnavailableSchema)({
      _tag: 'WorldWriteChunkUnavailable', dimension: 'end', chunk: '0,0',
    }))
    const commit = vi.spyOn(fixture.worldWrite.coordinator, 'commit').mockImplementationOnce(() => Effect.fail(unavailable))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(Result.isSuccess(fixture.core.tick(100))).toBe(true)
    expect(fixture.alice.map(decodeEnderDragonWireMessage)).toContainEqual(expect.objectContaining({ _tag: 'EnderDragonSnapshot' }))
    expect(fixture.lastState().wither).not.toStrictEqual(beforeWither)
    expect(fixture.lastState().wither?.withers[0]?.snapshot.state).toMatchObject({ phase: 'airborne', chargeRemainingSecs: 0 })
    expect(Effect.runSync(fixture.worldWrite.coordinator.revision)).toBe(0)
    expect(Effect.runSync(fixture.worldWrite.coordinator.dimensionRevision('end'))).toBe(0)
    expect(fixture.deltas(fixture.alice)).toEqual([])
    expect(fixture.deltas(fixture.bob)).toEqual([])
    expect(fixture.core.snapshot().blocks).toStrictEqual(beforeBlocks)
    expect(Effect.runSync(fixture.store.getBlock(at(center)))).toStrictEqual({ _tag: 'Block', block: STONE })
    expect(logged).toHaveBeenCalledExactlyOnceWith('Multiplayer wither block batch discarded', { worldId: WORLD, failure: unavailable })
    expect(Result.isSuccess(fixture.core.tick(100))).toBe(true)
    expect(commit).toHaveBeenCalledOnce()
    expect(fixture.deltas(fixture.bob)).toEqual([])
    logged.mockRestore()
    commit.mockRestore()
  })

  it('keeps the stored block and delta revision consistent across arbitrary place/break sequences', () => {
    fc.assert(fc.property(fc.array(fc.boolean()), (placements) => {
      const fixture = makeFixture()
      let present = false
      let remaining = 16
      let revision = 0
      for (const place of placements) {
        const accepted = place ? !present && remaining > 0 : present
        const result = place ? fixture.place() : fixture.breakBlock()
        expect(result.accepted).toBe(accepted)
        if (accepted) {
          present = place
          if (place) remaining -= 1
          revision += 1
        }
        expect(Effect.runSync(fixture.worldWrite.coordinator.revision)).toBe(revision)
        const actual = Effect.runSync(fixture.store.getBlock(at(P)))
        expect(actual).toStrictEqual({ _tag: 'Block', block: present ? STONE : AIR_BLOCK_ID })
        expect(fixture.deltas(fixture.bob).map(({ revision: value }) => value)).toEqual(
          Array.from({ length: revision }, (_, index) => index + 1),
        )
      }
    }))
  })
})
