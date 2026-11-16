import {
  BlockAxis, blockPosition, itemStackFromUnknown, WorldWriteChunkUnavailableSchema,
} from '@nerima-games/mc-kernel'
import {
  CONTAINER_STORAGE_REPLICATED_OWNER_ID, ContainerStorageSnapshotSchema, durabilityForItem,
  HOPPER_REPLICATED_OWNER_ID, HopperServiceSnapshotSchema, type ContainerStoredStack,
} from '@nerima-games/mc-sim'
import type { ChunkStoreApi } from '@nerima-games/mc-worldgen'
import {
  CommandId, decodeFrame, encodeFrame, PlayerId, PlayerName, WorldId,
  type NetworkMessage, type WireText,
} from '@nerima-games/mx-multiplayer'
import { Effect, Option, Result, Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  makeMultiplayerServerCore, type MultiplayerServerCoreParts, type MultiplayerServerState,
} from '../../apps/multiplayer-server/core'
import { makeMultiplayerServerCoreParts } from '../../apps/multiplayer-server/entrypoints/core-parts'
import { makeMultiplayerRedstoneRuntime } from '../../apps/multiplayer-server/redstone-runtime'
import type { ServerWorldWrite } from '../../apps/multiplayer-server/world-write-port'
import { replicatedOwners } from './codec'
import { airTerrain } from './terrain'

const PLAYER = PlayerId.make('hopper-observer')
const P = { x: 1, y: 64, z: 0 }
const ABOVE = { x: 1, y: 65, z: 0 }
const BELOW = { x: 1, y: 63, z: 0 }
const at = (p: Readonly<{ x: number; y: number; z: number }>) =>
  blockPosition(BlockAxis(p.x), BlockAxis(p.y), BlockAxis(p.z))
const stack = (item: string, count: number): ContainerStoredStack => ({
  ...Result.getOrThrow(itemStackFromUnknown(item, count)), durability: null,
})
const enchanted = (): ContainerStoredStack => ({
  ...Result.getOrThrow(itemStackFromUnknown('diamond_sword', 1, {
    componentPatch: { 'minecraft:enchantments': { 'minecraft:sharpness': 1 } },
  })),
  durability: durabilityForItem('diamond_sword'),
})
const slots = (capacity: number, first: ContainerStoredStack | null = null) =>
  Array.from({ length: capacity }, (_, index) => index === 0 ? first : null)
const frame = (message: NetworkMessage) => Result.getOrThrow(encodeFrame(message))
const messages = (frames: ReadonlyArray<WireText>) =>
  frames.map((wire) => Result.getOrThrow(decodeFrame(wire, replicatedOwners)))

const makeFixture = (
  name: string,
  dimension: 'overworld' | 'end' = 'overworld',
  state: Partial<MultiplayerServerState> = {},
) => {
  const world = WorldId.make(name)
  const writes: Array<ServerWorldWrite> = []
  const stores: Array<ChunkStoreApi> = []
  const persisted: Array<MultiplayerServerState> = []
  const realParts = makeMultiplayerServerCoreParts()
  const parts: MultiplayerServerCoreParts = {
    ...realParts,
    makeWorldWrite: (options) => {
      const result = realParts.makeWorldWrite(options)
      if (Result.isSuccess(result)) writes.push(result.success)
      return result
    },
    openChunkStore: (source) => {
      const result = realParts.openChunkStore(source)
      stores.push(result.store)
      return result
    },
  }
  const core = Result.getOrThrow(makeMultiplayerServerCore({
    worldId: world,
    dimension,
    seed: 42,
    allowedBlocks: new Set(['hopper', 'chest', 'dispenser', 'dropper', 'redstone_torch']),
    chunkSource: airTerrain,
    spawnAt: { x: 0, y: 64, z: 0 },
    parts,
    initialState: {
      revision: 0,
      blocks: [
        { at: ABOVE, block: 'chest' },
        { at: P, block: 'hopper' },
        { at: BELOW, block: 'chest' },
      ],
      containers: [
        { containerId: `${world}:1,65,0`, kind: 'chest', slots: slots(27, stack('apple', 2)) },
        { containerId: `${world}:1,64,0`, kind: 'hopper', slots: slots(5) },
        { containerId: `${world}:1,63,0`, kind: 'chest', slots: slots(27) },
      ],
      inventories: [{ player: PLAYER, state: { slots: [null, null], selectedSlot: 0 } }],
      vitals: [],
      timeWeather: { timeOfDay: 6000, weather: 'clear' },
      furnaces: [],
      villagerTrades: [],
      ...state,
    },
    onStateChanged: (next) => persisted.push(next),
  }))
  const write = Option.getOrThrow(Option.fromUndefinedOr(writes[0]))
  const store = Option.getOrThrow(Option.fromUndefinedOr(stores[0]))
  const sent: Array<WireText> = []
  expect(core.connect('observer', (wire) => sent.push(wire))).toBe(true)
  const receive = (message: NetworkMessage) => core.receive('observer', frame(message))
  expect(receive({
    _tag: 'PlayerJoin', player: PLAYER, name: PlayerName.make('Hopper observer'), at: { x: 0, y: 64, z: 0 },
  }).accepted).toBe(true)
  sent.length = 0
  persisted.length = 0
  const freshSnapshot = () => {
    const start = sent.length
    expect(receive({ _tag: 'AuthoritativeResyncRequest', world }).accepted).toBe(true)
    return Option.getOrThrow(Option.fromUndefinedOr(messages(sent.slice(start))
      .find((message) => message._tag === 'AuthoritativeSnapshot')))
  }
  const readOwners = () => Effect.runPromise(Effect.gen(function* () {
    const containers = yield* write.coordinator.snapshot(CONTAINER_STORAGE_REPLICATED_OWNER_ID, ContainerStorageSnapshotSchema)
    const hoppers = yield* write.coordinator.snapshot(HOPPER_REPLICATED_OWNER_ID, HopperServiceSnapshotSchema)
    return {
      containers: containers.state,
      hoppers: hoppers.state,
      revision: yield* write.coordinator.revision,
      dimensionRevision: yield* write.coordinator.dimensionRevision(dimension),
      block: yield* store.getBlockWithState(at(P)),
    }
  }))
  const canonicalSlots = async (position: typeof P) => {
    const snapshot = await readOwners()
    return Option.getOrThrow(Option.fromUndefinedOr(snapshot.containers.containers
      .find((container) => container.id === `${dimension}:${position.x},${position.y},${position.z}`))).slots
  }
  return { core, world, write, store, sent, persisted, receive, freshSnapshot, readOwners, canonicalSlots }
}

describe('coordinator-backed hopper runtime', () => {
  afterEach(() => vi.restoreAllMocks())

  it('pulls above and pushes down for a legacy hopper, preserving components and the eight-game-tick cooldown', async () => {
    const special = enchanted()
    const fixture = makeFixture('legacy-hopper-world', 'overworld', {
      containers: [
        { containerId: 'legacy-hopper-world:1,65,0', kind: 'chest', slots: slots(27, special) },
        { containerId: 'legacy-hopper-world:1,64,0', kind: 'hopper', slots: slots(5) },
        { containerId: 'legacy-hopper-world:1,63,0', kind: 'chest', slots: slots(27) },
      ],
    })
    const runtime = await makeMultiplayerRedstoneRuntime([{ dimension: 'overworld', core: fixture.core }])
    const commit = vi.spyOn(fixture.write.coordinator, 'commit')

    Result.getOrThrow(await Effect.runPromise(runtime.tick(100)))

    expect(commit).toHaveBeenCalledOnce()
    expect(commit.mock.calls[0]?.[0].blockWrite?.edits).toEqual([
      expect.objectContaining({ position: P }),
    ])
    expect(await fixture.canonicalSlots(ABOVE)).toEqual(slots(27))
    expect(await fixture.canonicalSlots(P)).toEqual(slots(5, special))
    const afterPull = await fixture.readOwners()
    expect(afterPull.hoppers.hoppers).toEqual([
      expect.objectContaining({ address: { dimension: 'overworld', position: P }, cooldownTicks: 8 }),
    ])
    expect(afterPull.containers.containers.map(({ id }) => id)).toEqual([
      'overworld:1,65,0', 'overworld:1,64,0', 'overworld:1,63,0',
    ])
    expect(afterPull.revision).toBe(1)
    expect(afterPull.dimensionRevision).toBe(1)
    expect(fixture.persisted.at(-1)?.containers.find(({ containerId }) => containerId === 'overworld:1,64,0')?.slots)
      .toEqual(slots(5, special))
    const emitted = messages(fixture.sent)
    expect(emitted.filter((message) => message._tag === 'ReplicatedWorldDelta')).toEqual([
      expect.objectContaining({ world: fixture.world, revision: 1, changes: [], blockChanges: [] }),
    ])
    expect(emitted.filter((message) => message._tag === 'ContainerDelta')).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: expect.objectContaining({ containerId: 'legacy-hopper-world:1,65,0', slots: slots(27) }) }),
      expect.objectContaining({ state: expect.objectContaining({ containerId: 'legacy-hopper-world:1,64,0', slots: [{ item: 'diamond_sword', count: 1, durability: special.durability }, null, null, null, null] }) }),
    ]))

    Result.getOrThrow(await Effect.runPromise(runtime.tick(300)))

    expect(await fixture.canonicalSlots(P)).toEqual(slots(5, special))
    expect(await fixture.canonicalSlots(BELOW)).toEqual(slots(27))
    expect((await fixture.readOwners()).hoppers.hoppers[0]?.cooldownTicks).toBe(2)

    Result.getOrThrow(await Effect.runPromise(runtime.tick(100)))

    expect(await fixture.canonicalSlots(P)).toEqual(slots(5))
    expect(await fixture.canonicalSlots(BELOW)).toEqual(slots(27, special))
    expect(fixture.persisted.at(-1)?.containers.find(({ containerId }) => containerId === 'overworld:1,63,0')?.slots)
      .toEqual(slots(27, special))
    expect((await fixture.readOwners()).hoppers.hoppers[0]?.cooldownTicks).toBe(8)
    const revisions = messages(fixture.sent).filter((message) => message._tag === 'ReplicatedWorldDelta')
      .map((message) => message.revision)
    expect(revisions).toEqual(Array.from({ length: revisions.length }, (_, index) => index + 1))
  })

  it('uses encoded facing and stops disabled and redstone-powered hoppers', async () => {
    const fixture = makeFixture('configured-hopper-world', 'overworld', {
      blocks: [
        { at: P, block: 'hopper', state: { facing: 'east', enabled: true } },
        { at: { x: 2, y: 64, z: 0 }, block: 'chest' },
        { at: BELOW, block: 'chest' },
        { at: { x: 5, y: 64, z: 0 }, block: 'hopper', state: { facing: 'down', enabled: false } },
        { at: { x: 5, y: 63, z: 0 }, block: 'chest' },
        { at: { x: 9, y: 64, z: 0 }, block: 'hopper' },
        { at: { x: 9, y: 63, z: 0 }, block: 'chest' },
        { at: { x: 10, y: 64, z: 0 }, block: 'redstone_torch' },
      ],
      containers: [
        { containerId: 'configured-hopper-world:1,64,0', kind: 'hopper', slots: slots(5, stack('apple', 2)) },
        { containerId: 'configured-hopper-world:2,64,0', kind: 'chest', slots: slots(27) },
        { containerId: 'configured-hopper-world:1,63,0', kind: 'chest', slots: slots(27) },
        { containerId: 'configured-hopper-world:5,64,0', kind: 'hopper', slots: slots(5, stack('apple', 2)) },
        { containerId: 'configured-hopper-world:5,63,0', kind: 'chest', slots: slots(27) },
        { containerId: 'configured-hopper-world:9,64,0', kind: 'hopper', slots: slots(5, stack('apple', 2)) },
        { containerId: 'configured-hopper-world:9,63,0', kind: 'chest', slots: slots(27) },
      ],
    })
    const runtime = await makeMultiplayerRedstoneRuntime([{ dimension: 'overworld', core: fixture.core }])

    Result.getOrThrow(await Effect.runPromise(runtime.tick(100)))

    expect(await fixture.canonicalSlots({ x: 2, y: 64, z: 0 })).toEqual(slots(27, stack('apple', 1)))
    expect(await fixture.canonicalSlots(BELOW)).toEqual(slots(27))
    for (const x of [5, 9]) {
      expect(await fixture.canonicalSlots({ x, y: 64, z: 0 })).toEqual(slots(5, stack('apple', 2)))
      expect(await fixture.canonicalSlots({ x, y: 63, z: 0 })).toEqual(slots(27))
    }
    expect(Result.getOrThrow(fixture.core.readHopperState(P))).toEqual({ facing: 'east', enabled: true })
  })

  it('leaves block and both owner states unchanged when a real runtime commit fails, then processes a new event', async () => {
    const fixture = makeFixture('refused-hopper-world')
    const runtime = await makeMultiplayerRedstoneRuntime([{ dimension: 'overworld', core: fixture.core }])
    Result.getOrThrow(fixture.core.readPistonCell(P))
    const before = await fixture.readOwners()
    const beforeWire = fixture.freshSnapshot()
    fixture.sent.length = 0
    const unavailable = Result.getOrThrow(Schema.decodeUnknownResult(WorldWriteChunkUnavailableSchema)({
      _tag: 'WorldWriteChunkUnavailable', dimension: 'overworld', chunk: '0,0',
    }))
    const commit = vi.spyOn(fixture.write.coordinator, 'commit').mockImplementationOnce(() => Effect.fail(unavailable))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    Result.getOrThrow(await Effect.runPromise(runtime.tick(100)))

    expect(commit).toHaveBeenCalledOnce()
    expect(await fixture.readOwners()).toEqual(before)
    expect(fixture.freshSnapshot()).toEqual(beforeWire)
    expect(fixture.persisted).toEqual([])
    expect(messages(fixture.sent).filter((message) => message._tag === 'ContainerDelta' || message._tag === 'ReplicatedWorldDelta')).toEqual([])
    expect(logged).toHaveBeenCalledExactlyOnceWith('Multiplayer hopper transfer failed', {
      dimension: 'overworld', failure: { _tag: 'HopperFailure', failure: unavailable },
    })

    Result.getOrThrow(await Effect.runPromise(runtime.tick(100)))

    expect(commit).toHaveBeenCalledTimes(2)
    expect(await fixture.canonicalSlots(P)).toEqual(slots(5, stack('apple', 1)))
    expect((await fixture.readOwners()).revision).toBe(1)
  })

  it('commits simultaneous hopper activity independently in two real realm runtimes', async () => {
    const overworld = makeFixture('multi-overworld')
    const end = makeFixture('multi-end', 'end')
    const runtime = await makeMultiplayerRedstoneRuntime([
      { dimension: 'overworld', core: overworld.core },
      { dimension: 'end', core: end.core },
    ])
    const overworldCommit = vi.spyOn(overworld.write.coordinator, 'commit')
    const endCommit = vi.spyOn(end.write.coordinator, 'commit')

    Result.getOrThrow(await Effect.runPromise(runtime.tick(100)))

    for (const [fixture, commit, dimension] of [
      [overworld, overworldCommit, 'overworld'],
      [end, endCommit, 'end'],
    ] as const) {
      expect(commit).toHaveBeenCalledOnce()
      expect(commit.mock.calls[0]?.[0].blockWrite?.dimension).toBe(dimension)
      expect(await fixture.canonicalSlots(P)).toEqual(slots(5, stack('apple', 1)))
      expect((await fixture.readOwners()).revision).toBe(1)
      expect(messages(fixture.sent).filter((message) => message._tag === 'ReplicatedWorldDelta')).toEqual([
        expect.objectContaining({ world: fixture.world, revision: 1, changes: [] }),
      ])
    }
  })

  it('refuses lossy player transfers, facility ejections, and block drops without changing canonical data', async () => {
    const special = enchanted()
    const fixture = makeFixture('metadata-boundary-world', 'overworld', {
      blocks: [
        { at: P, block: 'chest' },
        { at: { x: 2, y: 64, z: 0 }, block: 'dispenser' },
        { at: { x: 3, y: 64, z: 0 }, block: 'dropper' },
        { at: { x: 2, y: 64, z: 1 }, block: 'redstone_torch' },
        { at: { x: 3, y: 64, z: -1 }, block: 'redstone_torch' },
      ],
      containers: [
        { containerId: 'metadata-boundary-world:1,64,0', kind: 'chest', slots: slots(27, special) },
        { containerId: 'metadata-boundary-world:2,64,0', kind: 'dispenser', slots: slots(9, special) },
        { containerId: 'metadata-boundary-world:3,64,0', kind: 'dropper', slots: slots(9, special) },
      ],
    })
    Result.getOrThrow(fixture.core.readPistonCell(P))
    const before = await fixture.readOwners()
    const beforeWire = fixture.freshSnapshot()
    fixture.sent.length = 0

    expect(fixture.receive({
      _tag: 'ContainerCommand', commandId: CommandId.make('take-enchanted'),
      player: PLAYER, world: fixture.world, expectedRevision: beforeWire.revision,
      containerId: 'metadata-boundary-world:1,64,0',
      action: {
        _tag: 'move-item', source: { _tag: 'container-slot', slot: 0 },
        destination: { _tag: 'player-slot', slot: 0 }, count: 1,
      },
    })).toEqual({ accepted: false, reason: 'invalid-command' })

    expect(messages(fixture.sent)).toContainEqual(expect.objectContaining({
      _tag: 'AuthoritativeCommandRejected', commandId: 'take-enchanted', reason: 'invalid-command',
    }))
    expect(fixture.receive({ _tag: 'BlockBreak', player: PLAYER, world: fixture.world, at: P })).toMatchObject({
      accepted: false, reason: 'invalid-mutation',
      failure: { _tag: 'UnsupportedContainerItemComponents', containerId: 'metadata-boundary-world:1,64,0', slot: 0 },
    })
    for (const result of [
      fixture.core.applyDispenserTrigger({ x: 2, y: 64, z: 0 }),
      fixture.core.applyDropperTrigger({ x: 3, y: 64, z: 0 }),
    ]) {
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure._tag).toBe('UnsupportedContainerItemComponents')
    }
    const runtime = await makeMultiplayerRedstoneRuntime([{ dimension: 'overworld', core: fixture.core }])
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    Result.getOrThrow(await Effect.runPromise(runtime.tick(100)))

    expect(logged).toHaveBeenCalledTimes(2)
    for (const x of [2, 3]) {
      expect(logged).toHaveBeenCalledWith('Multiplayer redstone container transfer failed', {
        dimension: 'overworld', position: { x, y: 64, z: 0 },
        failure: { _tag: 'UnsupportedContainerItemComponents', containerId: `metadata-boundary-world:${x},64,0`, slot: 0 },
      })
    }
    expect(await fixture.readOwners()).toEqual(before)
    expect(fixture.freshSnapshot()).toEqual(beforeWire)
    expect(fixture.persisted).toEqual([])
  })
})
