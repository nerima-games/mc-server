import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { itemStackFromUnknown } from '@nerima-games/mc-kernel'
import { CHEST_CONTAINER_CAPACITY, CONTAINER_STORAGE_REPLICATED_OWNER_ID, ContainerStorageSnapshotSchema } from '@nerima-games/mc-sim'
import { CommandId, decodeFrame, encodeFrame, PlayerId, PlayerName, WorldId, type NetworkMessage, type WireText } from '@nerima-games/mx-multiplayer'
import { Effect, Option, Result } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeMultiplayerServerCore, type MultiplayerServerCoreParts, type MultiplayerServerState } from '../../apps/multiplayer-server/core'
import { makeMultiplayerServerCoreParts } from '../../apps/multiplayer-server/entrypoints/core-parts'
import { loadServerState } from '../../apps/multiplayer-server/main'
import type { ServerWorldWrite } from '../../apps/multiplayer-server/world-write-port'
import { replicatedOwners } from './codec'
import { airTerrain } from './terrain'

const WORLD = WorldId.make('guard:world')
const PLAYER = PlayerId.make('guard-player')
const POSITION = { x: 1, y: 64, z: 0 }
const CANONICAL_ID = 'overworld:1,64,0'
const WIRE_ID = `${WORLD}:1,64,0`
const emptySlots = () => Array.from({ length: CHEST_CONTAINER_CAPACITY }, () => null)
const state = (containerId: string): MultiplayerServerState => ({
  revision: 0, blocks: [{ at: POSITION, block: 'chest' }],
  containers: [{ containerId, kind: 'chest', slots: emptySlots() }],
  inventories: [{ player: PLAYER, state: { slots: [{ item: 'stone', count: 2 }], selectedSlot: 0 } }],
  vitals: [], timeWeather: { timeOfDay: 6000, weather: 'clear' }, furnaces: [], villagerTrades: [],
})
const construct = (containerId: string) => {
  const writes: Array<ServerWorldWrite> = []
  const saved: Array<MultiplayerServerState> = []
  const realParts = makeMultiplayerServerCoreParts()
  const parts: MultiplayerServerCoreParts = {
    ...realParts,
    makeWorldWrite: (options) => {
      const made = realParts.makeWorldWrite(options)
      if (Result.isSuccess(made)) writes.push(made.success)
      return made
    },
  }
  const result = makeMultiplayerServerCore({
    worldId: WORLD, dimension: 'overworld', seed: 42, chunkSource: airTerrain,
    allowedBlocks: new Set(['chest']), parts, spawnAt: { x: 0, y: 64, z: 0 },
    initialState: state(containerId), onStateChanged: (snapshot) => saved.push(snapshot),
  })
  return { result, writes, saved }
}
const messages = (frames: ReadonlyArray<WireText>) =>
  frames.map((frame) => Result.getOrThrow(decodeFrame(frame, replicatedOwners)))
const serializedState = (containerId: string, format: 1 | 2): unknown => ({
  ...state(containerId),
  inventories: [{ player: PLAYER, state: {
    slots: [format === 1 ? { item: 'stone', count: 2 } : { item: 'stone', count: 2, components: null }],
    selectedSlot: 0,
  } }],
  containers: [{
    containerId, kind: 'chest',
    slots: format === 1 ? [{ item: 'stone', count: 3 }] : [
      { item: 'stone', count: 3, components: null, durability: null },
      ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null),
    ],
  }],
})
const writeFixture = (path: string, containerId: string, format: 1 | 2) =>
  writeFile(path, JSON.stringify({ format, worldId: WORLD, seed: 42, state: serializedState(containerId, format) }), 'utf8')
const storedStone = { ...Result.getOrThrow(itemStackFromUnknown('stone', 3)), durability: null }

describe('container ID guard boundaries', () => {
  it('rejects a core initial ID whose spelling differs from its parsed block position', () => {
    const id = 'overworld:01,64,0'
    expect(construct(id).result).toStrictEqual(Result.fail({ _tag: 'SavedContainerIdInvalid', containerId: id }))
    expect(Result.isSuccess(construct(CANONICAL_ID).result)).toBe(true)
  })

  it('rejects a wire ID alias without changing state and accepts the canonical ID at the same position', () => {
    const fixture = construct(CANONICAL_ID)
    const core = Result.getOrThrow(fixture.result)
    const write = Option.getOrThrow(Option.fromUndefinedOr(fixture.writes[0]))
    const sent: Array<WireText> = []
    const receive = (message: NetworkMessage) => core.receive('guard-socket', Result.getOrThrow(encodeFrame(message)))
    expect(core.connect('guard-socket', (frame) => sent.push(frame))).toBe(true)
    expect(receive({
      _tag: 'PlayerJoin', player: PLAYER, name: PlayerName.make('Guard'), at: { x: 0, y: 64, z: 0 },
    }).accepted).toBe(true)
    const fresh = () => {
      sent.length = 0
      expect(receive({ _tag: 'AuthoritativeResyncRequest', world: WORLD }).accepted).toBe(true)
      const snapshots = messages(sent).filter((message) => message._tag === 'AuthoritativeSnapshot')
      expect(snapshots).toHaveLength(1)
      return Option.getOrThrow(Option.fromUndefinedOr(snapshots[0]))
    }
    const before = fresh()
    const beforeBlocks = core.snapshot().blocks
    const beforeOwner = Effect.runSync(write.coordinator.snapshot(CONTAINER_STORAGE_REPLICATED_OWNER_ID, ContainerStorageSnapshotSchema))
    sent.length = 0
    fixture.saved.length = 0
    const move = (commandId: string, containerId: string): NetworkMessage => ({
      _tag: 'ContainerCommand', commandId: CommandId.make(commandId), player: PLAYER, world: WORLD,
      expectedRevision: before.revision, containerId,
      action: { _tag: 'move-item', source: { _tag: 'player-slot', slot: 0 },
        destination: { _tag: 'container-slot', slot: 0 }, count: 1 },
    })
    expect(receive(move('alias', `${WORLD}:01,64,0`))).toStrictEqual({ accepted: false, reason: 'invalid-command' })
    expect(messages(sent)).toStrictEqual([{
      _tag: 'AuthoritativeCommandRejected', commandId: CommandId.make('alias'), world: WORLD,
      revision: before.revision, reason: 'invalid-command', resyncRequired: false,
    }])
    expect(fixture.saved).toStrictEqual([])
    expect(core.snapshot().blocks).toStrictEqual(beforeBlocks)
    expect(Effect.runSync(write.coordinator.revision)).toBe(0)
    expect(Effect.runSync(write.coordinator.dimensionRevision('overworld'))).toBe(0)
    expect(Effect.runSync(write.coordinator.snapshot(CONTAINER_STORAGE_REPLICATED_OWNER_ID, ContainerStorageSnapshotSchema))).toStrictEqual(beforeOwner)
    expect(fresh()).toStrictEqual(before)
    sent.length = 0
    expect(receive(move('canonical', WIRE_ID)).accepted).toBe(true)
    const after = fresh()
    expect(after.inventories.find(({ player }) => player === PLAYER)?.state.slots[0]).toStrictEqual({ item: 'stone', count: 1 })
    expect(after.containers.find(({ containerId }) => containerId === WIRE_ID)?.slots).toStrictEqual([
      { item: 'stone', count: 1 }, ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null),
    ])
    expect(Effect.runSync(write.coordinator.revision)).toBe(1)
    expect(fixture.saved).toHaveLength(1)
  })

  it('rejects noncanonical format 2 ID spelling before it can be normalized', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'container-id-format2-')), 'state.json')
    const id = 'overworld:01,64,0'
    await writeFixture(path, id, 2)
    const before = await readFile(path, 'utf8')
    expect(await loadServerState(path, WORLD, 42)).toStrictEqual(Result.fail({ _tag: 'SavedContainerIdInvalid', containerId: id }))
    expect(await readFile(path, 'utf8')).toBe(before)
    await writeFixture(path, CANONICAL_ID, 2)
    const loaded = Option.getOrThrow(Option.fromUndefinedOr(Result.getOrThrow(await loadServerState(path, WORLD, 42))))
    expect(loaded.containers).toStrictEqual([{
      containerId: CANONICAL_ID, kind: 'chest',
      slots: [storedStone, ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null)],
    }])
  })

  it('rejects a foreign format 1 world prefix of the same length as the expected prefix', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'container-id-format1-')), 'state.json')
    const foreignPrefix = 'other:world'
    expect(foreignPrefix.length).toBe(WORLD.length)
    const id = `${foreignPrefix}:1,64,0`
    await writeFixture(path, id, 1)
    const before = await readFile(path, 'utf8')
    expect(await loadServerState(path, WORLD, 42)).toStrictEqual(Result.fail({ _tag: 'SavedContainerIdInvalid', containerId: id }))
    expect(await readFile(path, 'utf8')).toBe(before)
    await writeFixture(path, WIRE_ID, 1)
    const loaded = Option.getOrThrow(Option.fromUndefinedOr(Result.getOrThrow(await loadServerState(path, WORLD, 42))))
    expect(loaded.containers).toStrictEqual([{
      containerId: CANONICAL_ID, kind: 'chest',
      slots: [storedStone, ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null)],
    }])
  })
})
