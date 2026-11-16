import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  emptyBrewingStandState,
  emptyStatusEffectState,
  initialEnderDragonEncounter,
} from '@nerima-games/mx-gameplay'
import { EntityId, type PlayerId } from '@nerima-games/mx-multiplayer'
import { Result } from 'effect'
import { describe, expect, it } from 'vitest'

import type { MultiplayerServerState } from '../../apps/multiplayer-server/core'
import { createLatestStatePersistence, loadServerState, writeServerState } from '../../apps/multiplayer-server/main'
import { initialWitherRuntimeState, snapshotWitherRuntime, summonRuntimeWither } from '../../apps/multiplayer-shared/wither-runtime'

const playerId = (value: string): PlayerId => value as PlayerId

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
    })

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
    })

    persistence.request('first')
    const draining = persistence.drain()
    persistence.request('latest')
    firstWrite.resolve()
    await draining

    expect(writes).toEqual(['first', 'latest'])
  })

  it('reports the latest failure and clears it after a successful retry', async () => {
    let shouldFail = true
    const persistence = createLatestStatePersistence(async () => {
      if (shouldFail) throw new Error('disk unavailable')
    })

    persistence.request(1)
    await expect(persistence.drain()).rejects.toThrow('disk unavailable')

    shouldFail = false
    await expect(persistence.drain()).resolves.toBeUndefined()
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
    })

    persistence.request(1)
    await persistence.drain()

    expect(writes).toEqual([1, 2])
    expect(maxActive).toBe(1)
  })

  it('persists undefined when it is a valid state value', async () => {
    const writes: Array<number | undefined> = []
    const persistence = createLatestStatePersistence<number | undefined>(async (state) => {
      writes.push(state)
    })

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

  it('reads back every category the writer persists, including levers, the ender dragon encounter, brewing stands, status effects, anvil names, and enchantments', async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'mc-compose-round-trip-')), 'state.json')
    const written = fullyPopulatedState()

    await writeServerState(stateFile, worldId, seed, written)
    const loaded = await loadServerState(stateFile, worldId, seed)

    expect(loaded).toEqual(Result.succeed(written))
  })

  const writeStateWithCow = async (mobState: Readonly<{ attackCooldownSecs: number; motionPhase: number; provoked: boolean }>): Promise<string> => {
    const stateFile = join(await mkdtemp(join(tmpdir(), 'mc-compose-round-trip-')), 'state.json')
    await writeServerState(stateFile, worldId, seed, {
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
      await writeServerState(stateFile, worldId, seed, state)
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

    await writeServerState(stateFile, worldId, seed, legacyState)
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
