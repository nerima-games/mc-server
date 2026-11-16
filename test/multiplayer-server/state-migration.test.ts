import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { brewingStateFromWire, brewingStateToWire } from '@nerima-games/mx-multiplayer'
import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { MultiplayerServerState } from '../../apps/multiplayer-server/core'
import { loadServerState, writeServerState } from '../../apps/multiplayer-server/main'
import { migrateLegacyBrewingState } from '../../apps/multiplayer-server/legacy-state'

const at = { x: 4, y: 64, z: 4 }
const worldId = 'migration-world'
const seed = 7
const emptyWire = {
  bottles: [null, null, null], ingredient: null, fuel: null, fuelCharges: 0, brewProgressSecs: 0,
}
const potionCases = [
  { potion: 'awkward', item: 'awkward_potion' },
  { potion: 'speed', item: 'potion_of_swiftness' },
  { potion: 'poison', item: 'potion_of_poison' },
  { potion: 'regeneration', item: 'potion_of_regeneration' },
]
const oldShapes = [
  { name: 'empty', old: { fuelUnits: 0 }, wire: emptyWire },
  { name: 'water bottle', old: { fuelUnits: 0, bottle: 'water_bottle' },
    wire: { ...emptyWire, bottles: [{ item: 'water_bottle', count: 1 }, null, null] } },
  ...potionCases.map(({ potion, item }) => ({
    name: `finished ${potion}`, old: { fuelUnits: 0, bottle: { potion } },
    wire: { ...emptyWire, bottles: [{ item, count: 1 }, null, null] },
  })),
  ...['nether_wart', 'sugar', 'spider_eye', 'ghast_tear'].map((ingredient) => ({
    name: `ingredient ${ingredient}`, old: { fuelUnits: 0, ingredient },
    wire: { ...emptyWire, ingredient: { item: ingredient, count: 1 } },
  })),
  { name: 'waiting water and wart', old: { fuelUnits: 0, bottle: 'water_bottle', ingredient: 'nether_wart' },
    wire: { ...emptyWire, bottles: [{ item: 'water_bottle', count: 1 }, null, null], ingredient: { item: 'nether_wart', count: 1 } } },
  ...['sugar', 'spider_eye', 'ghast_tear'].map((ingredient) => ({
    name: `waiting awkward and ${ingredient}`, old: { fuelUnits: 0, bottle: { potion: 'awkward' }, ingredient },
    wire: { ...emptyWire, bottles: [{ item: 'awkward_potion', count: 1 }, null, null], ingredient: { item: ingredient, count: 1 } },
  })),
  ...potionCases.map(({ potion, item }) => ({
    name: `in-progress ${potion}`, old: { fuelUnits: 7, bottle: 'water_bottle', brewing: { output: potion, remainingSecs: 0.25 } },
    wire: { ...emptyWire, bottles: [{ item, count: 1 }, null, null], fuelCharges: 7 },
  })),
  ...[
    { units: 20, charges: 20, powder: 0 },
    { units: 21, charges: 20, powder: 1 },
    { units: 40, charges: 20, powder: 1 },
    { units: 41, charges: 20, powder: 2 },
    { units: 1300, charges: 20, powder: 64 },
  ].map(({ units, charges, powder }) => ({
    name: `fuel ${units}`, old: { fuelUnits: units },
    wire: { ...emptyWire, fuelCharges: charges, fuel: powder === 0 ? null : { item: 'blaze_powder', count: powder } },
  })),
]

describe.each([1, 2])('format %s to format 3 migration', (format) => {
  it.each(oldShapes)('migrates $name through the file reader and preserves it after writing', async ({ old, wire }) => {
    const path = join(await mkdtemp(join(tmpdir(), 'server-migration-')), 'state.json')
    await writeFile(path, JSON.stringify({ format, worldId, seed, state: {
      revision: 0, blocks: [], brewingStands: [{ at, state: old }],
      furnaces: [{ furnaceId: 'furnace', input: null, fuel: null, output: null, burnTicksRemaining: 37, cookTicks: 12 }],
    } }), 'utf8')
    const loaded = Result.getOrThrow(await loadServerState(path, worldId, seed))
    expect(loaded).toBeDefined()
    expect(loaded?.brewingStands).toEqual([{ at, state: Result.getOrThrow(brewingStateFromWire(wire)) }])
    expect(loaded?.furnaces).toEqual([{
      furnaceId: 'furnace', station: 'furnace', input: null, fuel: null, output: null,
      burnTicksRemaining: 37, burnTicksTotal: 37, cookTicks: 12,
    }])
    if (loaded === undefined) throw new Error('expected migrated state')
    expect(await writeServerState(path, worldId, seed, loaded)).toEqual(Result.succeed(undefined))
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ format: 3 })
    expect(await loadServerState(path, worldId, seed)).toEqual(Result.succeed(loaded))
  })

  it.each([
    { name: 'fuel beyond one stack', state: { fuelUnits: 1301 } },
    { name: 'maximum fuel beyond one stack', state: { fuelUnits: Number.MAX_SAFE_INTEGER } },
    { name: 'negative fuel', state: { fuelUnits: -1 } },
    { name: 'fractional fuel', state: { fuelUnits: 0.5 } },
    { name: 'missing fuel', state: {} },
    { name: 'unknown potion', state: { fuelUnits: 0, bottle: { potion: 'unknown' } } },
    { name: 'incompatible recipe', state: { fuelUnits: 0, bottle: 'water_bottle', ingredient: 'sugar' } },
    { name: 'progress without bottle', state: { fuelUnits: 0, brewing: { output: 'speed', remainingSecs: 1 } } },
    { name: 'progress with ingredient', state: { fuelUnits: 0, bottle: 'water_bottle', ingredient: 'sugar', brewing: { output: 'speed', remainingSecs: 1 } } },
    { name: 'zero progress duration', state: { fuelUnits: 0, bottle: 'water_bottle', brewing: { output: 'speed', remainingSecs: 0 } } },
  ])('returns a typed failure for $name without replacing the old file', async ({ state }) => {
    const path = join(await mkdtemp(join(tmpdir(), 'server-migration-invalid-')), 'state.json')
    const source = JSON.stringify({ format, worldId, seed, state: { revision: 0, blocks: [], brewingStands: [{ at, state }] } })
    await writeFile(path, source, 'utf8')
    expect(await loadServerState(path, worldId, seed)).toMatchObject(Result.fail({ _tag: 'SavedServerStateFailure', path: 'brewingStands' }))
    expect(await readFile(path, 'utf8')).toBe(source)
  })

  it('preserves all generated legacy brewing shapes and fuel through migration and a format 3 file round trip', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'server-migration-property-')), 'state.json')
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...oldShapes),
      fc.integer({ min: 0, max: 1300 }),
      fc.nat({ max: 100_000 }),
      async ({ old, wire }, fuelUnits, burnTicksRemaining) => {
        const migrated = Result.getOrThrow(migrateLegacyBrewingState({ ...old, fuelUnits }))
        const newWire = Result.getOrThrow(brewingStateToWire(migrated))
        expect(newWire.bottles).toEqual(wire.bottles)
        expect(newWire.ingredient).toEqual(wire.ingredient)
        expect(newWire.brewProgressSecs).toBe(0)
        expect(newWire.fuelCharges).toBe(Math.min(fuelUnits, 20))
        const powder = Math.ceil(Math.max(0, fuelUnits - 20) / 20)
        expect(newWire.fuel).toEqual(powder === 0 ? null : { item: 'blaze_powder', count: powder })
        await writeFile(path, JSON.stringify({ format, worldId, seed, state: {
          revision: 0, blocks: [], brewingStands: [{ at, state: { ...old, fuelUnits } }],
          furnaces: [{ furnaceId: 'furnace', input: null, fuel: null, output: null, burnTicksRemaining, cookTicks: 0 }],
        } }), 'utf8')
        const loaded = Result.getOrThrow(await loadServerState(path, worldId, seed))
        expect(loaded?.brewingStands).toEqual([{ at, state: migrated }])
        expect(loaded?.furnaces[0]?.burnTicksTotal).toBe(burnTicksRemaining)
        if (loaded === undefined) throw new Error('expected migrated state')
        expect(await writeServerState(path, worldId, seed, loaded)).toEqual(Result.succeed(undefined))
        expect(await loadServerState(path, worldId, seed)).toEqual(Result.succeed(loaded))
      },
    ))
  })
})

describe('format 3 state validation', () => {
  it('keeps three bottle stacks, ingredient, fuel, fractional progress and furnace station/total through a file round trip', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'server-format3-')), 'state.json')
    const state: MultiplayerServerState = {
      revision: 0, blocks: [], inventories: [], vitals: [], timeWeather: { timeOfDay: 6000, weather: 'clear' },
      containers: [], villagerTrades: [], entities: [],
      brewingStands: [{ at, state: Result.getOrThrow(brewingStateFromWire({
        bottles: [{ item: 'water_bottle', count: 1 }, { item: 'awkward_potion', count: 1 }, { item: 'potion_of_poison', count: 1 }],
        ingredient: { item: 'nether_wart', count: 5 }, fuel: { item: 'blaze_powder', count: 4 },
        fuelCharges: 13, brewProgressSecs: 3.125,
      })) }],
      furnaces: [{ furnaceId: 'furnace', station: 'smoker', input: null, fuel: null, output: null, burnTicksRemaining: 9, burnTicksTotal: 40, cookTicks: 2 }],
    }
    expect(await writeServerState(path, worldId, seed, state)).toEqual(Result.succeed(undefined))
    const loaded = Result.getOrThrow(await loadServerState(path, worldId, seed))
    expect(loaded?.brewingStands).toEqual(state.brewingStands)
    expect(loaded?.furnaces).toEqual(state.furnaces)
  })

  it.each([
    { name: 'two bottles', wire: { ...emptyWire, bottles: [null, null] } },
    { name: 'four bottles', wire: { ...emptyWire, bottles: [null, null, null, null] } },
    { name: 'excess fuel', wire: { ...emptyWire, fuelCharges: 21 } },
    { name: 'completed progress', wire: { ...emptyWire, brewProgressSecs: 20 } },
    { name: 'negative progress', wire: { ...emptyWire, brewProgressSecs: -1 } },
  ])('returns a typed failure for $name', async ({ wire }) => {
    const path = join(await mkdtemp(join(tmpdir(), 'server-format3-invalid-')), 'state.json')
    await writeFile(path, JSON.stringify({ format: 3, worldId, seed, state: {
      revision: 0, blocks: [], brewingStands: [{ at, state: wire }],
    } }), 'utf8')
    expect(await loadServerState(path, worldId, seed)).toMatchObject(Result.fail({ _tag: 'SavedServerStateFailure', path: 'brewingStands' }))
  })

  it.each([
    'null', '{}', '{"format":3}', '{"format":3,"worldId":"migration-world","seed":7,"state":null}', '{',
  ])('returns a typed failure for malformed envelope %s', async (source) => {
    const path = join(await mkdtemp(join(tmpdir(), 'server-envelope-invalid-')), 'state.json')
    await writeFile(path, source, 'utf8')
    expect(await loadServerState(path, worldId, seed)).toMatchObject(Result.fail({ _tag: 'SavedServerStateFailure' }))
  })
})
