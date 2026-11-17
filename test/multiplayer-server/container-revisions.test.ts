import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { itemStackFromUnknown } from '@nerima-games/mc-kernel'
import {
  CONTAINER_STORAGE_REPLICATED_OWNER_ID, ContainerStorageSnapshotSchema,
} from '@nerima-games/mc-sim'
import {
  CommandId, decodeFrame, encodeFrame, PlayerId, PlayerName, WorldId,
  type NetworkMessage, type WireText,
} from '@nerima-games/mx-multiplayer'
import { Effect, Option, Result } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  makeMultiplayerServerCore, type MultiplayerServerCoreParts, type MultiplayerServerState,
} from '../../apps/multiplayer-server/core'
import { makeMultiplayerServerCoreParts } from '../../apps/multiplayer-server/entrypoints/core-parts'
import { loadServerState, writeServerState } from '../../apps/multiplayer-server/main'
import type { ServerWorldWrite } from '../../apps/multiplayer-server/world-write-port'
import { replicatedOwners } from './codec'
import { airTerrain } from './terrain'

const WORLD = WorldId.make('container-clock-world')
const PLAYER = PlayerId.make('tool-owner')
const DAMAGED = { current: 128, max: 1561 }
const CHEST_ID = 'overworld:1,64,0'
const WIRE_CHEST_ID = 'container-clock-world:1,64,0'
const emptySlots = () => Array.from({ length: 27 }, () => null)
const frame = (message: NetworkMessage) => Result.getOrThrow(encodeFrame(message))
const messages = (frames: ReadonlyArray<WireText>) =>
  frames.map((wire) => Result.getOrThrow(decodeFrame(wire, replicatedOwners)))

const openCore = (state: MultiplayerServerState) => {
  const writes: Array<ServerWorldWrite> = []
  const saved: Array<MultiplayerServerState> = []
  const realParts = makeMultiplayerServerCoreParts()
  const parts: MultiplayerServerCoreParts = {
    ...realParts,
    makeWorldWrite: (options) => {
      const result = realParts.makeWorldWrite(options)
      if (Result.isSuccess(result)) writes.push(result.success)
      return result
    },
  }
  const core = Result.getOrThrow(makeMultiplayerServerCore({
    worldId: WORLD, dimension: 'overworld', seed: 42, chunkSource: airTerrain,
    allowedBlocks: new Set(['chest']), parts, initialState: state,
    spawnAt: { x: 0, y: 64, z: 0 }, onStateChanged: (snapshot) => saved.push(snapshot),
  }))
  const write = Option.getOrThrow(Option.fromUndefinedOr(writes[0]))
  const sent: Array<WireText> = []
  expect(core.connect('tool-socket', (wire) => sent.push(wire))).toBe(true)
  const receive = (message: NetworkMessage) => core.receive('tool-socket', frame(message))
  expect(receive({
    _tag: 'PlayerJoin', player: PLAYER, name: PlayerName.make('Tool owner'), at: { x: 0, y: 64, z: 0 },
  }).accepted).toBe(true)
  sent.length = 0
  saved.length = 0
  const freshSnapshot = () => {
    const start = sent.length
    expect(receive({ _tag: 'AuthoritativeResyncRequest', world: WORLD }).accepted).toBe(true)
    return Option.getOrThrow(Option.fromUndefinedOr(messages(sent.slice(start))
      .find((message) => message._tag === 'AuthoritativeSnapshot')))
  }
  const container = async () => {
    const snapshot = await Effect.runPromise(write.coordinator.snapshot(
      CONTAINER_STORAGE_REPLICATED_OWNER_ID, ContainerStorageSnapshotSchema,
    ))
    return Option.getOrThrow(Option.fromUndefinedOr(snapshot.state.containers.find(({ id }) => id === CHEST_ID)))
  }
  return { core, write, saved, sent, receive, freshSnapshot, container }
}

describe('canonical container commands and storage revisions', () => {
  it('retains table-only tool damage through deposit, format 3 save, reboot and withdrawal, publishing both storage clocks', async () => {
    const state: MultiplayerServerState = {
      revision: 0,
      blocks: [{ at: { x: 1, y: 64, z: 0 }, block: 'chest' }],
      containers: [{ containerId: CHEST_ID, kind: 'chest', slots: emptySlots() }],
      inventories: [{
        player: PLAYER,
        state: { slots: [{ item: 'diamond_sword', count: 1 }, null], durability: [DAMAGED, null], selectedSlot: 0 },
      }],
      vitals: [], timeWeather: { timeOfDay: 6000, weather: 'clear' }, furnaces: [], villagerTrades: [],
    }
    const original = openCore(state)
    const before = original.freshSnapshot()
    original.sent.length = 0

    expect(original.receive({
      _tag: 'ContainerCommand', commandId: CommandId.make('deposit-damaged-sword'),
      player: PLAYER, world: WORLD, expectedRevision: before.revision, containerId: WIRE_CHEST_ID,
      action: {
        _tag: 'move-item', source: { _tag: 'player-slot', slot: 0 },
        destination: { _tag: 'container-slot', slot: 0 }, count: 1,
      },
    }).accepted).toBe(true)

    const damagedCanonical = { ...Result.getOrThrow(itemStackFromUnknown('diamond_sword', 1)), durability: DAMAGED }
    expect((await original.container()).slots).toEqual([damagedCanonical, ...Array.from({ length: 26 }, () => null)])
    expect(original.freshSnapshot().inventories.find(({ player }) => player === PLAYER)?.state.slots[0]).toBeNull()
    expect(await Effect.runPromise(original.write.coordinator.revision)).toBe(1)
    expect(messages(original.sent).filter((message) => message._tag === 'ReplicatedWorldDelta')).toEqual([
      { _tag: 'ReplicatedWorldDelta', world: WORLD, revision: 1, changes: [], blockChanges: [] },
    ])
    expect(messages(original.sent)).toContainEqual(expect.objectContaining({
      _tag: 'ContainerDelta', state: expect.objectContaining({
        containerId: WIRE_CHEST_ID,
        slots: [{ item: 'diamond_sword', count: 1, durability: DAMAGED }, ...Array.from({ length: 26 }, () => null)],
      }),
    }))

    const saved = Option.getOrThrow(Option.fromUndefinedOr(original.saved.at(-1)))
    expect(saved.containers[0]?.slots[0]).toEqual(damagedCanonical)
    const stateFile = join(await mkdtemp(join(tmpdir(), 'container-tool-revisions-')), 'state.json')
    Result.getOrThrow(await writeServerState(stateFile, WORLD, 42, saved))
    const encoded: unknown = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(encoded).toMatchObject({ format: 3, state: { containers: [{
      containerId: CHEST_ID,
      slots: [{ item: 'diamond_sword', count: 1, components: null, durability: DAMAGED }, ...Array.from({ length: 26 }, () => null)],
    }] } })
    const loaded = Option.getOrThrow(Option.fromUndefinedOr(Result.getOrThrow(await loadServerState(stateFile, WORLD, 42))))
    expect(loaded.containers[0]?.slots[0]).toEqual(damagedCanonical)

    const rebooted = openCore(loaded)
    expect((await rebooted.container()).slots[0]).toEqual(damagedCanonical)
    const afterReboot = rebooted.freshSnapshot()
    rebooted.sent.length = 0

    expect(rebooted.receive({
      _tag: 'ContainerCommand', commandId: CommandId.make('withdraw-damaged-sword'),
      player: PLAYER, world: WORLD, expectedRevision: afterReboot.revision, containerId: WIRE_CHEST_ID,
      action: {
        _tag: 'move-item', source: { _tag: 'container-slot', slot: 0 },
        destination: { _tag: 'player-slot', slot: 1 }, count: 1,
      },
    }).accepted).toBe(true)

    expect((await rebooted.container()).slots).toEqual(emptySlots())
    expect(rebooted.freshSnapshot().inventories.find(({ player }) => player === PLAYER)?.state.slots[1])
      .toEqual({ item: 'diamond_sword', count: 1, durability: DAMAGED })
    expect(await Effect.runPromise(rebooted.write.coordinator.revision)).toBe(1)
    expect(messages(rebooted.sent).filter((message) => message._tag === 'ReplicatedWorldDelta')).toEqual([
      { _tag: 'ReplicatedWorldDelta', world: WORLD, revision: 1, changes: [], blockChanges: [] },
    ])
    expect(messages(rebooted.sent)).toContainEqual(expect.objectContaining({
      _tag: 'ContainerDelta', state: { containerId: WIRE_CHEST_ID, kind: 'chest', slots: emptySlots() },
    }))
  })
})
