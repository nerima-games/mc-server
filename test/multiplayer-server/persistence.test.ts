import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  emptyBrewingStandState,
  emptyStatusEffectState,
  initialEnderDragonEncounter,
} from '@nerima-games/mx-gameplay'
import { EntityId, PlayerId, PlayerName, encodeFrame, type ContainerKind } from '@nerima-games/mx-multiplayer'
import { PositionAxis, position, itemStackFromUnknown } from '@nerima-games/mc-kernel'
import { CHEST_CONTAINER_CAPACITY, containerCapacity, durabilityForItem, LegacyItemStackSchema, WitherProjectileSpeed, witherSkullProjectile } from '@nerima-games/mc-sim'
import { Option, Result, Schema } from 'effect'
import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'

import { makeMultiplayerServerCore, type MultiplayerServerState } from '../../apps/multiplayer-server/core'
import { makeMultiplayerServerCoreParts } from '../../apps/multiplayer-server/entrypoints/core-parts'
import { createLatestStatePersistence, loadServerState, writeServerState } from '../../apps/multiplayer-server/main'
import { airTerrain } from './terrain'
import { initialWitherRuntimeState, snapshotWitherRuntime, summonRuntimeWither } from '../../apps/multiplayer-shared/wither-runtime'

const playerId = (value: string): PlayerId => PlayerId.make(value)
const persistState = async (path: string, worldId: string, seed: number, state: MultiplayerServerState): Promise<void> => {
  expect(await writeServerState(path, worldId, seed, state)).toEqual(Result.succeed(undefined))
}

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('latest multiplayer state persistence', () => {
  it('coalesces updates queued behind an active write to the latest state', async () => {
    const firstWrite = deferred<void>()
    const writes: number[] = []
    const persistence = createLatestStatePersistence(async (state: number) => {
      writes.push(state)
      if (writes.length === 1) await firstWrite.promise
    }, vi.fn())

    persistence.request(1)
    await Promise.resolve()
    persistence.request(2)
    persistence.request(3)
    firstWrite.resolve()
    await persistence.drain()

    expect(writes).toEqual([1, 3])
  })

  it('drains an update requested while the previous write is settling', async () => {
    const firstWrite = deferred<void>()
    const writes: string[] = []
    const persistence = createLatestStatePersistence(async (state: string) => {
      writes.push(state)
      if (state === 'first') await firstWrite.promise
    }, vi.fn())

    persistence.request('first')
    const draining = persistence.drain()
    persistence.request('latest')
    firstWrite.resolve()
    await draining

    expect(writes).toEqual(['first', 'latest'])
  })

  const failures: ReadonlyArray<Readonly<{ label: string; failure: unknown }>> = [
    { label: 'Error', failure: new Error('disk unavailable') },
    { label: 'undefined', failure: undefined },
  ]
  it.each(failures)('reports $label immediately and stops all later writes while drain preserves the original failure', async ({ failure }) => {
    const reported = deferred<unknown>()
    const writes: number[] = []
    const onFailure = vi.fn((error: unknown) => reported.resolve(error))
    const persistence = createLatestStatePersistence(async (state: number) => {
      writes.push(state)
      throw failure
    }, onFailure)
    persistence.request(1)
    persistence.request(2)
    expect(await reported.promise).toBe(failure)
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure)
    persistence.request(3)
    await expect(persistence.drain()).rejects.toBe(failure)
    await expect(persistence.drain()).rejects.toBe(failure)
    expect(writes).toStrictEqual([1])
    expect(onFailure).toHaveBeenCalledOnce()
  })

  it('reserves the writer before a synchronous reentrant request', async () => {
    let persistence!: ReturnType<typeof createLatestStatePersistence<number>>
    let active = 0
    let maxActive = 0
    const writes: number[] = []
    persistence = createLatestStatePersistence(async (state) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      writes.push(state)
      if (state === 1) persistence.request(2)
      await Promise.resolve()
      active -= 1
    }, vi.fn())

    persistence.request(1)
    await persistence.drain()

    expect(writes).toEqual([1, 2])
    expect(maxActive).toBe(1)
  })

  it('persists undefined when it is a valid state value', async () => {
    const writes: Array<number | undefined> = []
    const persistence = createLatestStatePersistence<number | undefined>(async (state) => {
      writes.push(state)
    }, vi.fn())

    persistence.request(undefined)
    await persistence.drain()

    expect(writes).toEqual([undefined])
  })
})

describe('multiplayer state file round trip', () => {
  const worldId = 'round-trip-world'
  const seed = 7
  const alice = playerId('alice')

  const fullyPopulatedState = (): MultiplayerServerState => ({
    revision: 5,
    blocks: [{ at: { x: 1, y: 64, z: 1 }, block: 'stone' }],
    poweredRails: [{ at: { x: 2, y: 64, z: 2 }, powered: true }],
    levers: [{ at: { x: 3, y: 64, z: 3 }, active: true }],
    inventories: [{ player: alice, state: { slots: [], selectedSlot: 0 } }],
    vitals: [{ player: alice, state: { health: 20, hunger: 20, experience: 0 } }],
    timeWeather: { timeOfDay: 6_000, weather: 'clear' },
    weatherClock: { remainingSecs: 30, seed: 1 },
    containers: [],
    furnaces: [],
    villagerTrades: [],
    entities: [],
    eyeOfEnderRecoveries: [],
    playerPositions: [{
      player: alice,
      at: { x: 0, y: 64, z: 0 },
      facing: { yawRadians: 0, pitchRadians: 0 },
    }],
    wither: snapshotWitherRuntime(initialWitherRuntimeState()),
    witherRevision: 2,
    enderDragon: initialEnderDragonEncounter(),
    enderDragonRevision: 3,
    brewingStands: [{ at: { x: 4, y: 64, z: 4 }, state: emptyBrewingStandState() }],
    statusEffects: [{ player: alice, state: emptyStatusEffectState() }],
    anvilNames: [{ player: alice, names: [{ slot: 0, name: 'Endbringer' }] }],
    enchantments: [{
      player: alice,
      seed: 73,
      items: [{ slot: 0, item: { item: 'stone', durability: null, enchantments: [] } }],
    }],
  })

  it.each([
    { label: 'null state', block: 'oak_log', state: null, tag: 'SavedBlockStateFailure' },
    { label: 'invalid axis', block: 'oak_log', state: { axis: 'diagonal' }, tag: 'SavedBlockStateFailure' },
    { label: 'unsupported property', block: 'stone', state: { age: 1 }, tag: 'SavedBlockStateFailure' },
    { label: 'unknown block with state', block: 'unregistered-test-block', state: { axis: 'x' }, tag: 'BlockOverrideNotInRegistry' },
  ])('returns a typed failure for persisted $label', async ({ block, state, tag }) => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-invalid-block-state-')), 'state.json')
    await writeFile(stateFile, JSON.stringify({
      format: 1, worldId, seed,
      state: {
        ...fullyPopulatedState(),
        blocks: [{ at: { x: 1, y: 64, z: 1 }, block, state }],
      },
    }), 'utf8')

    const loaded = await loadServerState(stateFile, worldId, seed)

    expect(Result.isFailure(loaded)).toBe(true)
    if (Result.isFailure(loaded)) expect(loaded.failure).toMatchObject({ _tag: tag })
  })

  it('reads back every category the writer persists, including levers, the ender dragon encounter, brewing stands, status effects, anvil names, and enchantments', async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'mc-compose-round-trip-')), 'state.json')
    const written = fullyPopulatedState()

    await persistState(stateFile, worldId, seed, written)
    const loaded = await loadServerState(stateFile, worldId, seed)

    expect(loaded).toEqual(Result.succeed(written))
  })


  it('migrates format 1 items and writes LegacyItemStackSchema values for every item-bearing field in format 2', async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-items-format-')), 'state.json')
    const oldContainer = {
      containerId: `${worldId}:0,64,0`, kind: 'chest',
      slots: [{ item: 'bow', count: 1, durability: { current: 128, max: 384 } },
        ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null)],
    }
    const legacy = {
      ...fullyPopulatedState(),
      inventories: [{ player: alice, state: {
        slots: [{ item: 'stone', count: 8 }], selectedSlot: 0,
        equipment: { head: null, chest: null, legs: null, feet: null,
          offhand: { item: 'bow', count: 1, durability: { current: 128, max: 384 } } },
      } }],
      containers: [oldContainer],
      furnaces: [{ furnaceId: '["round-trip-world",2,64,0]', input: { item: 'iron_ore', count: 1 },
        fuel: { item: 'coal', count: 1 }, output: { item: 'iron_ingot', count: 1 },
        burnTicksRemaining: 0, cookTicks: 0 }],
      villagerTrades: [{ villagerId: 'trader', offers: [{ offerId: 'bread', input: [{ item: 'emerald', count: 1 }],
        output: { item: 'bread', count: 1 }, uses: 0, maxUses: 10 }] }],
      entities: [{ _tag: 'item-drop', entityId: 'saved-drop', at: { x: 1, y: 64, z: 1 }, stack: { item: 'stone', count: 2 } }],
    }
    await writeFile(stateFile, JSON.stringify({ format: 1, worldId, seed, state: legacy }), 'utf8')
    const migrated = Option.getOrThrow(Option.fromUndefinedOr(Result.getOrThrow(await loadServerState(stateFile, worldId, seed))))
    expect(migrated.containers[0]?.slots[0]).toStrictEqual({
      ...Result.getOrThrow(itemStackFromUnknown('bow', 1)), durability: { current: 128, max: 384 },
    })
    await persistState(stateFile, worldId, seed, migrated)
    const saved: unknown = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(saved).toMatchObject({ format: 2, state: {
      inventories: [{ state: { slots: [{ item: 'stone', count: 8, components: null }],
        equipment: { offhand: { item: 'bow', count: 1, components: null, durability: { current: 128, max: 384 } } } } }],
      containers: [{ slots: [{ item: 'bow', count: 1, components: null, durability: { current: 128, max: 384 } },
        ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null)] }],
      furnaces: [{ input: { item: 'iron_ore', count: 1, components: null }, fuel: { item: 'coal', count: 1, components: null },
        output: { item: 'iron_ingot', count: 1, components: null } }],
      villagerTrades: [{ offers: [{ input: [{ item: 'emerald', count: 1, components: null }], output: { item: 'bread', count: 1, components: null } }] }],
      entities: [{ stack: { item: 'stone', count: 2, components: null } }],
    } })
    expect(await loadServerState(stateFile, worldId, seed)).toEqual(Result.succeed(migrated))
  })

  it('preserves canonical container enchantments, names and durability through a file round trip and a real core reboot', async () => {
    const stack = Result.getOrThrow(itemStackFromUnknown('bow', 1, { componentPatch: {
      'minecraft:enchantments': { 'minecraft:power': 3 },
      'minecraft:custom_name': { text: 'Keeper' },
    } }))
    expect(stack.components.enchantments).toEqual({ 'minecraft:power': 3 })
    const state: MultiplayerServerState = { ...fullyPopulatedState(), containers: [{
      containerId: 'overworld:0,64,0', kind: 'chest',
      slots: [{ ...stack, durability: { current: 128, max: 384 } },
        ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null)],
    }] }
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-component-round-trip-')), 'state.json')
    await persistState(stateFile, worldId, seed, state)
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toMatchObject({ format: 2, state: { containers: [{ slots: [
      expect.objectContaining({ components: expect.objectContaining({ enchantments: { 'minecraft:power': 3 } }),
        durability: { current: 128, max: 384 } }),
      ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null),
    ] }] } })
    const loaded = Option.getOrThrow(Option.fromUndefinedOr(Result.getOrThrow(await loadServerState(stateFile, worldId, seed))))
    expect(loaded).toStrictEqual({
      ...state, brewingStands: [{ at: { x: 4, y: 64, z: 4 }, state: { fuelUnits: 0 } }],
    })
    expect(loaded.containers).toStrictEqual(state.containers)
    const persisted: Array<MultiplayerServerState> = []
    const core = Result.getOrThrow(makeMultiplayerServerCore({
      worldId, seed, allowedBlocks: new Set(['chest']), chunkSource: airTerrain,
      parts: makeMultiplayerServerCoreParts(), spawnAt: { x: 0, y: 64, z: 0 },
      initialState: loaded, onStateChanged: (snapshot) => persisted.push(snapshot),
    }))
    expect(core.connect('reboot-player', () => undefined)).toBe(true)
    expect(core.receive('reboot-player', Result.getOrThrow(encodeFrame({
      _tag: 'PlayerJoin', player: alice, name: PlayerName.make('Alice'), at: { x: 0, y: 64, z: 0 },
    }))).accepted).toBe(true)
    const afterReboot = Option.getOrThrow(Option.fromUndefinedOr(persisted.at(-1)))
    expect(afterReboot.containers).toStrictEqual(state.containers)
  })

  it.each([1, 2])('rejects unknown components in format %s with a typed failure', async (format) => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-invalid-components-')), 'state.json')
    await writeFile(stateFile, JSON.stringify({ format, worldId, seed, state: {
      ...fullyPopulatedState(), containers: [{ containerId: format === 1 ? `${worldId}:0,64,0` : 'overworld:0,64,0', kind: 'chest',
        slots: [{ item: 'stone', count: 1, components: { unknownComponent: true }, durability: null },
          ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null)] }],
    } }), 'utf8')
    expect(await loadServerState(stateFile, worldId, seed)).toMatchObject(Result.fail({
      _tag: 'SavedItemStackFailure', path: 'containers.0.slots.0',
    }))
  })

  it('rejects supported nondefault components outside canonical containers instead of discarding them', async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-unsupported-components-')), 'state.json')
    const stack = Result.getOrThrow(itemStackFromUnknown('bow', 1, {
      componentPatch: { 'minecraft:enchantments': { 'minecraft:power': 3 } },
    }))
    const encoded = Result.getOrThrow(Schema.encodeResult(LegacyItemStackSchema)(stack))
    await writeFile(stateFile, JSON.stringify({ format: 2, worldId, seed, state: {
      ...fullyPopulatedState(), inventories: [{ player: alice, state: { slots: [encoded], selectedSlot: 0 } }],
    } }), 'utf8')
    expect(await loadServerState(stateFile, worldId, seed)).toMatchObject(Result.fail({
      _tag: 'SavedItemStackFailure', path: 'inventories.0.state.slots.0',
    }))
  })


  it('rejects nondefault components supplied structurally to the public writer without replacing saved data', async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-writer-components-')), 'state.json')
    const good = fullyPopulatedState()
    await persistState(stateFile, worldId, seed, good)
    const before = await readFile(stateFile, 'utf8')
    const enchanted = Result.getOrThrow(itemStackFromUnknown('bow', 1, {
      componentPatch: { 'minecraft:enchantments': { 'minecraft:power': 3 } },
    }))
    const suppliedSlot = { item: 'bow', count: 1, components: enchanted.components }
    expect(await writeServerState(stateFile, worldId, seed, { ...good,
      inventories: [{ player: alice, state: { slots: [suppliedSlot], selectedSlot: 0 } }],
    })).toMatchObject(Result.fail({ _tag: 'SavedItemStackFailure', path: 'inventories.0.state.slots.0' }))
    expect(await readFile(stateFile, 'utf8')).toBe(before)
    expect(await loadServerState(stateFile, worldId, seed)).toEqual(Result.succeed(good))
  })

  it('accepts explicitly supplied default components in noncontainer stacks without adding them to the runtime inventory', async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-default-components-')), 'state.json')
    const plain = Result.getOrThrow(itemStackFromUnknown('stone', 1))
    const suppliedSlot = { item: 'stone', count: 1, components: plain.components }
    const state: MultiplayerServerState = { ...fullyPopulatedState(),
      inventories: [{ player: alice, state: { slots: [suppliedSlot], selectedSlot: 0 } }],
    }
    await persistState(stateFile, worldId, seed, state)
    const loaded = Result.getOrThrow(await loadServerState(stateFile, worldId, seed))
    expect(loaded?.inventories).toStrictEqual([{ player: alice, state: { slots: [{ item: 'stone', count: 1 }], selectedSlot: 0 } }])
  })

  it.each([0, -1, 65])('rejects an invalid saved stack count %s before replacing the existing file', async (count) => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-invalid-save-stack-')), 'state.json')
    const good = fullyPopulatedState()
    await persistState(stateFile, worldId, seed, good)
    const before = await readFile(stateFile, 'utf8')
    expect(await writeServerState(stateFile, worldId, seed, { ...good,
      inventories: [{ player: alice, state: { slots: [{ item: 'stone', count }], selectedSlot: 0 } }],
    })).toMatchObject(Result.fail({ _tag: 'SavedItemStackFailure', path: 'inventories.0.state.slots.0' }))
    expect(await readFile(stateFile, 'utf8')).toBe(before)
    expect(await loadServerState(stateFile, worldId, seed)).toEqual(Result.succeed(good))
  })



  it('migrates omitted legacy sword durability to the public default while rejecting explicit null', async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-legacy-durable-item-')), 'state.json')
    const state = { ...fullyPopulatedState(), containers: [{
      containerId: `${worldId}:0,64,0`, kind: 'chest',
      slots: [{ item: 'diamond_sword', count: 1 }, ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null)],
    }] }
    await writeFile(stateFile, JSON.stringify({ format: 1, worldId, seed, state }), 'utf8')
    const loaded = Option.getOrThrow(Option.fromUndefinedOr(Result.getOrThrow(await loadServerState(stateFile, worldId, seed))))
    expect(loaded.containers[0]?.slots[0]).toStrictEqual({
      ...Result.getOrThrow(itemStackFromUnknown('diamond_sword', 1)), durability: durabilityForItem('diamond_sword'),
    })
    await persistState(stateFile, worldId, seed, loaded)
    expect(await loadServerState(stateFile, worldId, seed)).toStrictEqual(Result.succeed(loaded))
    await writeFile(stateFile, JSON.stringify({ format: 1, worldId, seed, state: { ...state, containers: [{
      ...state.containers[0], slots: [{ item: 'diamond_sword', count: 1, durability: null },
        ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null)],
    }] } }), 'utf8')
    expect(await loadServerState(stateFile, worldId, seed)).toMatchObject(Result.fail({
      _tag: 'SavedItemStackFailure', path: 'containers.0.slots.0',
    }))
  })

  it('rejects an omitted durability field in a format 2 canonical container stack', async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-canonical-durability-')), 'state.json')
    await writeFile(stateFile, JSON.stringify({ format: 2, worldId, seed, state: { ...fullyPopulatedState(), containers: [{
      containerId: 'overworld:0,64,0', kind: 'chest',
      slots: [{ item: 'stone', count: 1, components: null }, ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null)],
    }] } }), 'utf8')
    expect(await loadServerState(stateFile, worldId, seed)).toMatchObject(Result.fail({
      _tag: 'SavedItemStackFailure', path: 'containers.0.slots.0',
    }))
  })

  const invalidStoredDurability: ReadonlyArray<Readonly<{
    label: string
    item: string
    durability: Readonly<{ current: number; max: number }> | null
  }>> = [
    { label: 'non-durable item', item: 'apple', durability: { current: 1, max: 10 } },
    { label: 'missing durable state', item: 'diamond_sword', durability: null },
    { label: 'wrong durable range', item: 'diamond_sword', durability: { current: 1, max: 10 } },
  ]
  it.each(invalidStoredDurability)('rejects $label on read and before replacing a file', async ({ item, durability }) => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-container-durability-')), 'state.json')
    const good = fullyPopulatedState()
    await persistState(stateFile, worldId, seed, good)
    const before = await readFile(stateFile, 'utf8')
    const stack = Result.getOrThrow(itemStackFromUnknown(item, 1))
    const slots = [{ ...stack, durability }, ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null)]
    const state: MultiplayerServerState = { ...good, containers: [{
      containerId: 'overworld:0,64,0', kind: 'chest', slots,
    }] }
    expect(await writeServerState(stateFile, worldId, seed, state)).toMatchObject(Result.fail({
      _tag: 'SavedItemStackFailure', path: 'containers.0.slots.0',
    }))
    expect(await readFile(stateFile, 'utf8')).toBe(before)
    expect(await loadServerState(stateFile, worldId, seed)).toEqual(Result.succeed(good))
    await writeFile(stateFile, JSON.stringify({ format: 2, worldId, seed, state: {
      ...good, containers: [{ containerId: 'overworld:0,64,0', kind: 'chest',
        slots: [{ item, count: 1, components: null, durability },
          ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null)] }],
    } }), 'utf8')
    expect(await loadServerState(stateFile, worldId, seed)).toMatchObject(Result.fail({
      _tag: 'SavedItemStackFailure', path: 'containers.0.slots.0',
    }))
  })

  it('preserves a valid damaged sword with its public durability range', async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-damaged-sword-')), 'state.json')
    const stack = Result.getOrThrow(itemStackFromUnknown('diamond_sword', 1))
    const full = Option.getOrThrow(Option.fromNullishOr(durabilityForItem('diamond_sword')))
    const damaged = { current: full.current - 1, max: full.max }
    const state: MultiplayerServerState = { ...fullyPopulatedState(), containers: [{
      containerId: 'overworld:0,64,0', kind: 'chest',
      slots: [{ ...stack, durability: damaged }, ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null)],
    }] }
    await persistState(stateFile, worldId, seed, state)
    const loaded = Result.getOrThrow(await loadServerState(stateFile, worldId, seed))
    expect(loaded).toStrictEqual({
      ...state, brewingStands: [{ at: { x: 4, y: 64, z: 4 }, state: { fuelUnits: 0 } }],
    })
    expect(loaded?.containers).toStrictEqual(state.containers)
  })



  const legacyContainerKinds: ReadonlyArray<Readonly<{ label: string; kind?: ContainerKind }>> = [
    { label: 'chest', kind: 'chest' }, { label: 'shulker box', kind: 'shulker_box' },
    { label: 'dispenser', kind: 'dispenser' }, { label: 'dropper', kind: 'dropper' },
    { label: 'hopper', kind: 'hopper' }, { label: 'omitted kind' },
  ]
  it.each(legacyContainerKinds)('pads a legacy short $label container without losing its items', async ({ kind }) => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-legacy-capacity-')), 'state.json')
    await writeFile(stateFile, JSON.stringify({ format: 1, worldId, seed, state: {
      ...fullyPopulatedState(), containers: [{ containerId: `${worldId}:0,64,0`, ...(kind === undefined ? {} : { kind }),
        slots: [{ item: 'stone', count: 3 }] }],
    } }), 'utf8')
    const loaded = Option.getOrThrow(Option.fromUndefinedOr(Result.getOrThrow(await loadServerState(stateFile, worldId, seed))))
    expect(loaded.containers[0]?.slots).toStrictEqual([
      { ...Result.getOrThrow(itemStackFromUnknown('stone', 3)), durability: null },
      ...Array.from({ length: containerCapacity(kind === undefined ? 'chest' : kind) - 1 }, () => null),
    ])
    await persistState(stateFile, worldId, seed, loaded)
    expect(await loadServerState(stateFile, worldId, seed)).toStrictEqual(Result.succeed(loaded))
  })

  it('rejects an oversized legacy container without truncating its saved slots', async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-legacy-oversize-')), 'state.json')
    const contents = JSON.stringify({ format: 1, worldId, seed, state: {
      ...fullyPopulatedState(), containers: [{ containerId: `${worldId}:0,64,0`, kind: 'hopper',
        slots: Array.from({ length: containerCapacity('hopper') + 1 }, () => ({ item: 'stone', count: 1 })) }],
    } })
    await writeFile(stateFile, contents, 'utf8')
    expect(await loadServerState(stateFile, worldId, seed)).toMatchObject(Result.fail({
      _tag: 'SavedItemStackFailure', path: 'containers',
    }))
    expect(await readFile(stateFile, 'utf8')).toBe(contents)
  })

  const invalidContainerLayouts: ReadonlyArray<Readonly<{
    label: string
    containers: MultiplayerServerState['containers']
    failure: Readonly<{ _tag: 'SavedItemStackFailure'; path: string }> | Readonly<{ _tag: 'SavedContainerIdInvalid'; containerId: string }>
  }>> = [
    { label: 'undersized chest', failure: { _tag: 'SavedItemStackFailure', path: 'containers' }, containers: [{ containerId: 'overworld:0,64,0', kind: 'chest', slots: [] }] },
    { label: 'oversized chest', failure: { _tag: 'SavedItemStackFailure', path: 'containers' }, containers: [{ containerId: 'overworld:0,64,0', kind: 'chest',
      slots: Array.from({ length: CHEST_CONTAINER_CAPACITY + 1 }, () => null) }] },
    { label: 'duplicate id', failure: { _tag: 'SavedItemStackFailure', path: 'containers' }, containers: [
      { containerId: 'overworld:0,64,0', kind: 'chest', slots: Array.from({ length: CHEST_CONTAINER_CAPACITY }, () => null) },
      { containerId: 'overworld:0,64,0', kind: 'chest', slots: Array.from({ length: CHEST_CONTAINER_CAPACITY }, () => null) },
    ] },
    { label: 'empty id', failure: { _tag: 'SavedContainerIdInvalid', containerId: '' }, containers: [{ containerId: '', kind: 'chest',
      slots: Array.from({ length: CHEST_CONTAINER_CAPACITY }, () => null) }] },
    { label: 'untrimmed id', failure: { _tag: 'SavedContainerIdInvalid', containerId: ' overworld:0,64,0' }, containers: [{ containerId: ' overworld:0,64,0', kind: 'chest',
      slots: Array.from({ length: CHEST_CONTAINER_CAPACITY }, () => null) }] },
  ]
  it.each(invalidContainerLayouts)('rejects $label on read and before replacing saved data', async ({ containers, failure }) => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-container-layout-')), 'state.json')
    const good = fullyPopulatedState()
    await persistState(stateFile, worldId, seed, good)
    const before = await readFile(stateFile, 'utf8')
    const bad = { ...good, containers }
    expect(await writeServerState(stateFile, worldId, seed, bad)).toMatchObject(Result.fail(failure))
    expect(await readFile(stateFile, 'utf8')).toBe(before)
    expect(await loadServerState(stateFile, worldId, seed)).toEqual(Result.succeed(good))
    await writeFile(stateFile, JSON.stringify({ format: 2, worldId, seed, state: bad }), 'utf8')
    expect(await loadServerState(stateFile, worldId, seed)).toMatchObject(Result.fail(failure))
  })

  it('returns a typed result without throwing for arbitrary persisted container components', async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-components-property-')), 'state.json')
    await fc.assert(fc.asyncProperty(fc.jsonValue(), async (components) => {
      await writeFile(stateFile, JSON.stringify({ format: 2, worldId, seed, state: {
        ...fullyPopulatedState(), containers: [{ containerId: 'overworld:0,64,0', kind: 'chest',
          slots: [{ item: 'stone', count: 1, components, durability: null }, ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null)] }],
      } }), 'utf8')
      const expected = Schema.decodeUnknownResult(LegacyItemStackSchema)({ item: 'stone', count: 1, components })
      const result = await loadServerState(stateFile, worldId, seed)
      expect(Result.isSuccess(result)).toBe(Result.isSuccess(expected))
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ _tag: 'SavedItemStackFailure', path: 'containers.0.slots.0' })
      } else {
        expect(result.success?.containers[0]?.slots[0]).toMatchObject({ item: 'stone', count: 1 })
      }
    }))
  })


  type LegacyItemLocation = Readonly<{ label: string; path: string; state: (stack: unknown) => unknown }>
  const legacyItemLocations: ReadonlyArray<LegacyItemLocation> = [
    { label: 'inventory', path: 'inventories.0.state.slots.0', state: (stack) => ({
      ...fullyPopulatedState(), inventories: [{ player: alice, state: { slots: [stack], selectedSlot: 0 } }],
    }) },
    ...['head', 'chest', 'legs', 'feet', 'offhand'].map((slot): LegacyItemLocation => ({
      label: `equipment ${slot}`, path: `inventories.0.state.equipment.${slot}`,
      state: (stack) => ({ ...fullyPopulatedState(), inventories: [{ player: alice, state: {
        slots: [], selectedSlot: 0,
        equipment: { head: null, chest: null, legs: null, feet: null, offhand: null, [slot]: stack },
      } }] }),
    })),
    ...['input', 'fuel', 'output'].map((slot): LegacyItemLocation => ({
      label: `furnace ${slot}`, path: `furnaces.0.${slot}`,
      state: (stack) => ({ ...fullyPopulatedState(), furnaces: [{
        furnaceId: '["round-trip-world",2,64,0]', input: null, fuel: null, output: null,
        burnTicksRemaining: 0, cookTicks: 0, [slot]: stack,
      }] }),
    })),
    { label: 'trade input', path: 'villagerTrades.0.offers.0.input.0', state: (stack) => ({
      ...fullyPopulatedState(), villagerTrades: [{ villagerId: 'trader', offers: [{
        offerId: 'offer', input: [stack], output: { item: 'bread', count: 1 }, uses: 0, maxUses: 10,
      }] }],
    }) },
    { label: 'trade output', path: 'villagerTrades.0.offers.0.output', state: (stack) => ({
      ...fullyPopulatedState(), villagerTrades: [{ villagerId: 'trader', offers: [{
        offerId: 'offer', input: [{ item: 'emerald', count: 1 }], output: stack, uses: 0, maxUses: 10,
      }] }],
    }) },
    { label: 'item drop', path: 'entities.0.stack', state: (stack) => ({
      ...fullyPopulatedState(), entities: [{ _tag: 'item-drop', entityId: 'legacy-drop',
        at: { x: 1, y: 64, z: 1 }, stack }],
    }) },
  ]
  it.each(legacyItemLocations)('validates legacy $label kernel items and refuses explicit components at startup', async ({ state, path }) => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-legacy-stack-validation-')), 'state.json')
    for (const stack of [
      { item: 'unknown-legacy-item', count: 1 },
      { item: 'stone', count: 1, components: { unsupported: true } },
    ]) {
      const before = JSON.stringify({ format: 1, worldId, seed, state: state(stack) })
      await writeFile(stateFile, before, 'utf8')
      expect(await loadServerState(stateFile, worldId, seed)).toMatchObject(Result.fail({
        _tag: 'SavedItemStackFailure', path,
      }))
      expect(await readFile(stateFile, 'utf8')).toBe(before)
    }
  })

  it('loads a stateless legacy hopper from its file and reads the canonical default state through the real core', async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-legacy-hopper-file-')), 'state.json')
    const hopperAt = { x: 1, y: 64, z: 0 }
    await writeFile(stateFile, JSON.stringify({ format: 1, worldId, seed, state: {
      ...fullyPopulatedState(), blocks: [{ at: hopperAt, block: 'hopper' }],
      containers: [{ containerId: `${worldId}:1,64,0`, kind: 'hopper', slots: [] }],
    } }), 'utf8')
    const loaded = Option.getOrThrow(Option.fromUndefinedOr(Result.getOrThrow(await loadServerState(stateFile, worldId, seed))))
    expect(loaded.containers).toStrictEqual([{ containerId: 'overworld:1,64,0', kind: 'hopper',
      slots: Array.from({ length: containerCapacity('hopper') }, () => null) }])
    const core = Result.getOrThrow(makeMultiplayerServerCore({
      worldId, seed, dimension: 'overworld', allowedBlocks: new Set(['hopper']), chunkSource: airTerrain,
      parts: makeMultiplayerServerCoreParts(), spawnAt: { x: 0, y: 64, z: 0 }, initialState: loaded,
    }))
    expect(core.readHopperState(hopperAt)).toStrictEqual(Result.succeed({ facing: 'down', enabled: true }))
  })

  it('migrates namespaced world container IDs only in format 1 and rejects world IDs in canonical format 2', async () => {
    const namespacedWorld = 'legacy:round-trip-world'
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-container-id-format-')), 'state.json')
    const legacy = { ...fullyPopulatedState(), containers: [{
      containerId: `${namespacedWorld}:0,64,0`, kind: 'chest', slots: [{ item: 'stone', count: 1 }],
    }] }
    await writeFile(stateFile, JSON.stringify({ format: 1, worldId: namespacedWorld, seed, state: legacy }), 'utf8')
    const loaded = Option.getOrThrow(Option.fromUndefinedOr(Result.getOrThrow(await loadServerState(stateFile, namespacedWorld, seed))))
    expect(loaded.containers[0]?.containerId).toBe('overworld:0,64,0')
    await persistState(stateFile, namespacedWorld, seed, loaded)
    const before = await readFile(stateFile, 'utf8')
    const wrong: MultiplayerServerState = { ...loaded, containers: loaded.containers.map((container) => ({
      ...container, containerId: `${namespacedWorld}:0,64,0`,
    })) }
    expect(await writeServerState(stateFile, namespacedWorld, seed, wrong)).toMatchObject(Result.fail({
      _tag: 'SavedContainerIdInvalid', containerId: `${namespacedWorld}:0,64,0`,
    }))
    expect(await readFile(stateFile, 'utf8')).toBe(before)
    await writeFile(stateFile, JSON.stringify({ format: 2, worldId: namespacedWorld, seed, state: {
      ...fullyPopulatedState(), containers: [{
        containerId: `${namespacedWorld}:0,64,0`, kind: 'chest',
        slots: [{ item: 'stone', count: 1, components: null, durability: null },
          ...Array.from({ length: CHEST_CONTAINER_CAPACITY - 1 }, () => null)],
      }],
    } }), 'utf8')
    expect(await loadServerState(stateFile, namespacedWorld, seed)).toMatchObject(Result.fail({
      _tag: 'SavedContainerIdInvalid', containerId: `${namespacedWorld}:0,64,0`,
    }))
  })


  it('rejects a legacy container ID with a trailing newline instead of normalizing it', async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'server-legacy-id-newline-')), 'state.json')
    const containerId = `${worldId}:1,64,0\n`
    const before = JSON.stringify({ format: 1, worldId, seed, state: {
      ...fullyPopulatedState(), containers: [{ containerId, kind: 'chest', slots: [] }],
    } })
    await writeFile(stateFile, before, 'utf8')
    expect(await loadServerState(stateFile, worldId, seed)).toMatchObject(Result.fail({
      _tag: 'SavedContainerIdInvalid', containerId,
    }))
    expect(await readFile(stateFile, 'utf8')).toBe(before)
  })

  const writeStateWithCow = async (mobState: Readonly<{ attackCooldownSecs: number; motionPhase: number; provoked: boolean }>): Promise<string> => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'mc-compose-round-trip-')), 'state.json')
    await persistState(stateFile, worldId, seed, {
      revision: 1,
      blocks: [],
      inventories: [],
      vitals: [],
      timeWeather: { timeOfDay: 6_000, weather: 'clear' },
      containers: [],
      furnaces: [],
      villagerTrades: [],
      entities: [{
        _tag: 'living', entityId: EntityId.make('cow-1'), entityType: 'cow', at: { x: 0, y: 64, z: 0 }, health: 10, maxHealth: 10, mobState,
      }],
    })
    return stateFile
  }

  it('loads a mob whose saved state mx-gameplay can repair', async () => {
    const loaded = await loadServerState(await writeStateWithCow({ attackCooldownSecs: 0, motionPhase: 3, provoked: false }), worldId, seed)
    expect(Result.isSuccess(loaded)).toBe(true)
  })

  it('fails to load a mob whose saved motion phase exceeds the safe integer range', async () => {
    const loaded = await loadServerState(await writeStateWithCow({ attackCooldownSecs: 0, motionPhase: 2 ** 60, provoked: false }), worldId, seed)
    expect(loaded).toMatchObject(Result.fail({ _tag: 'MobStateRepairFailure', entityId: 'cow-1' }))
  })

  describe('rejects saved positions outside addressable cells', () => {
    // Finite, but far enough apart that coordinate differences overflow to Infinity.
    const far = 1.7976931348623157e308
    const loadWith = async (state: MultiplayerServerState) => {
      const stateFile = join(await mkdtemp(join(tmpdir(), 'mc-compose-round-trip-')), 'state.json')
      await persistState(stateFile, worldId, seed, state)
      return loadServerState(stateFile, worldId, seed)
    }

    it('for an entity', async () => {
      const loaded = await loadWith({
        ...fullyPopulatedState(),
        entities: [{
          _tag: 'living', entityId: EntityId.make('creeper-1'), entityType: 'creeper', at: { x: far, y: 64, z: far }, health: 20, maxHealth: 20,
        }],
      })
      expect(loaded).toEqual(Result.fail({
        _tag: 'PositionOutsideAddressableCells', subject: 'entity', id: 'creeper-1', at: { x: far, y: 64, z: far },
      }))
    })

    it('for a player', async () => {
      const loaded = await loadWith({
        ...fullyPopulatedState(),
        playerPositions: [{ player: alice, at: { x: far, y: 64, z: 0 }, facing: { yawRadians: 0, pitchRadians: 0 } }],
      })
      expect(loaded).toEqual(Result.fail({
        _tag: 'PositionOutsideAddressableCells', subject: 'player', id: 'alice', at: { x: far, y: 64, z: 0 },
      }))
    })

    it('for a wither', async () => {
      const wither = Result.getOrThrow(summonRuntimeWither(initialWitherRuntimeState(), worldId, { x: far, y: 64, z: 0 }))
      const loaded = await loadWith({ ...fullyPopulatedState(), wither: snapshotWitherRuntime(wither) })
      expect(loaded).toEqual(Result.fail({
        _tag: 'PositionOutsideAddressableCells', subject: 'wither', id: 'wither-1', at: { x: far, y: 64, z: 0 },
      }))
    })

    it('for an eye of ender recovery', async () => {
      const loaded = await loadWith({
        ...fullyPopulatedState(),
        eyeOfEnderRecoveries: [{ entityId: EntityId.make('eye-1'), at: { x: 0, y: 64, z: far }, remainingSecs: 1 }],
      })
      expect(loaded).toEqual(Result.fail({
        _tag: 'PositionOutsideAddressableCells', subject: 'eye-of-ender-recovery', id: 'eye-1', at: { x: 0, y: 64, z: far },
      }))
    })
  })

  describe('rejects saved values every later tick would fail on', () => {
    const loadWith = async (state: MultiplayerServerState) => {
      const stateFile = join(await mkdtemp(join(tmpdir(), 'mc-compose-round-trip-')), 'state.json')
      await persistState(stateFile, worldId, seed, state)
      return loadServerState(stateFile, worldId, seed)
    }

    it('for a block edit whose name the block registry lacks', async () => {
      const loaded = await loadWith({
        ...fullyPopulatedState(),
        blocks: [{ at: { x: 64, y: 64, z: 0 }, block: 'legacy_unknown' }],
      })
      expect(loaded).toEqual(Result.fail({ _tag: 'BlockOverrideNotInRegistry', at: { x: 64, y: 64, z: 0 }, block: 'legacy_unknown' }))
    })

    it('for a furnace holding an item the item registry lacks', async () => {
      const stateFile = join(await mkdtemp(join(tmpdir(), 'server-legacy-furnace-')), 'state.json')
      await writeFile(stateFile, JSON.stringify({ format: 1, worldId, seed, state: {
        ...fullyPopulatedState(),
        furnaces: [{
          furnaceId: '["world-1",2,64,0]', input: { item: 'legacy_ore', count: 1 }, fuel: null, output: null,
          burnTicksRemaining: 0, cookTicks: 0,
        }],
      } }), 'utf8')
      const loaded = await loadServerState(stateFile, worldId, seed)
      expect(loaded).toMatchObject(Result.fail({
        _tag: 'SavedItemStackFailure', path: 'furnaces.0.input',
      }))
    })

    describe('for a Wither skull outside mc-sim projectile rules', () => {
      const origin = position(PositionAxis(0), PositionAxis(64), PositionAxis(0))
      const rules = witherSkullProjectile(origin, origin, 'normal')
      const withSkull = (descriptor: typeof rules): MultiplayerServerState => ({
        ...fullyPopulatedState(),
        wither: {
          nextWitherId: 1,
          nextSkullId: 1,
          withers: [],
          skulls: [{ id: 'skull-1', ownerId: 'wither-1', dimension: worldId, descriptor, position: origin, ageSecs: 0 }],
        },
      })

      it('rejects an overflowing direction at a speed mc-sim never gives', async () => {
        const loaded = await loadWith(withSkull({
          ...rules,
          direction: position(PositionAxis(Number.MAX_VALUE), PositionAxis(0), PositionAxis(0)),
          speed: WitherProjectileSpeed(14),
        }))
        expect(loaded).toEqual(Result.fail({ _tag: 'WitherSkullOutsideProjectileRules', id: 'skull-1' }))
      })

      it('rejects an overflowing direction at the variant speed', async () => {
        const loaded = await loadWith(withSkull({
          ...rules,
          direction: position(PositionAxis(Number.MAX_VALUE), PositionAxis(0), PositionAxis(0)),
        }))
        expect(loaded).toEqual(Result.fail({ _tag: 'WitherSkullOutsideProjectileRules', id: 'skull-1' }))
      })

      it('rejects a unit direction with a speed mc-sim never gives the variant', async () => {
        const loaded = await loadWith(withSkull({
          ...rules,
          direction: position(PositionAxis(1), PositionAxis(0), PositionAxis(0)),
          speed: WitherProjectileSpeed(14),
        }))
        expect(loaded).toEqual(Result.fail({ _tag: 'WitherSkullOutsideProjectileRules', id: 'skull-1' }))
      })

      it('loads a unit direction at the variant speed', async () => {
        const state = withSkull({ ...rules, direction: position(PositionAxis(1), PositionAxis(0), PositionAxis(0)) })
        expect(await loadWith(state)).toEqual(Result.succeed(state))
      })
    })
  })

  it('still loads a state file predating these fields, leaving the new categories empty', async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'mc-compose-round-trip-')), 'state.json')
    const legacyState: MultiplayerServerState = {
      revision: 1,
      blocks: [{ at: { x: 1, y: 64, z: 1 }, block: 'stone' }],
      inventories: [],
      vitals: [],
      timeWeather: { timeOfDay: 6_000, weather: 'clear' },
      containers: [],
      furnaces: [],
      villagerTrades: [],
    }

    await writeFile(stateFile, JSON.stringify({ format: 1, worldId, seed, state: legacyState }), 'utf8')
    const loadedResult = await loadServerState(stateFile, worldId, seed)
    expect(Result.isSuccess(loadedResult)).toBe(true)
    const loaded = Result.getOrThrow(loadedResult)

    expect(loaded).toMatchObject({
      revision: 1,
      levers: [],
      brewingStands: [],
      statusEffects: [],
      anvilNames: [],
      enchantments: [],
    })
    expect(loaded?.enderDragon).toBeUndefined()
    expect(loaded?.enderDragonRevision).toBeUndefined()
  })
})
