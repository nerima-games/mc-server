import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { brewingStateFromWire, brewingStateToWire } from '@nerima-games/mx-multiplayer'
import { LegacyItemStackSchema, validateBrewingSnapshot } from '@nerima-games/mc-sim'
import { Result, Schema } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { MultiplayerServerState } from '../../apps/multiplayer-server/core'
import { loadServerState, writeServerState } from '../../apps/multiplayer-server/main'
import { migrateLegacyBrewingState } from '../../apps/multiplayer-server/legacy-state'
import { migrateV17Brewing } from './fixtures/sp-v17-brewing.js'

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
    { units: 0, charges: 0, powder: 0 },
    { units: 19, charges: 19, powder: 0 },
    { units: 20, charges: 20, powder: 0 },
    { units: 21, charges: 20, powder: 1 },
    { units: 39, charges: 20, powder: 1 },
    { units: 40, charges: 20, powder: 1 },
    { units: 41, charges: 20, powder: 2 },
    { units: 59, charges: 20, powder: 2 },
    { units: 60, charges: 20, powder: 2 },
    { units: 1299, charges: 20, powder: 64 },
    { units: 1300, charges: 20, powder: 64 },
  ].map(({ units, charges, powder }) => ({
    name: `fuel ${units}`, old: { fuelUnits: units },
    wire: { ...emptyWire, fuelCharges: charges, fuel: powder === 0 ? null : { item: 'blaze_powder', count: powder } },
  })),
]


const encodedBrewingState = Schema.Struct({
  bottles: Schema.Tuple([Schema.NullOr(LegacyItemStackSchema), Schema.NullOr(LegacyItemStackSchema), Schema.NullOr(LegacyItemStackSchema)]),
  ingredient: Schema.NullOr(LegacyItemStackSchema),
  fuel: Schema.NullOr(LegacyItemStackSchema),
  fuelCharges: Schema.Number,
  brewProgressSecs: Schema.Number,
})
const migrationDirectory = await mkdtemp(join(tmpdir(), 'server-migration-'))
const legacyFurnace = { furnaceId: 'furnace', input: null, fuel: null, output: null, cookTicks: 0 }

const expectSinglePlayerMigration = (old: unknown, migrated: ReturnType<typeof migrateLegacyBrewingState>): void => {
  const singlePlayer = migrateV17Brewing(old)
  expect(Result.isSuccess(migrated)).toBe(Result.isSuccess(singlePlayer))
  if (Result.isSuccess(singlePlayer) && Result.isSuccess(migrated)) {
    const decoded = Result.getOrThrow(Schema.decodeUnknownResult(encodedBrewingState)(singlePlayer.success))
    const normalized = validateBrewingSnapshot(decoded)
    expect(normalized._tag).toBe('Valid')
    if (normalized._tag === 'Valid') expect(migrated.success).toEqual(normalized.state)
  }
}

describe.each([1, 2])('format %s to format 3 migration', (format) => {
  const envelope = { format, worldId, seed }
  it.each(oldShapes)('migrates $name through the file reader and preserves it after writing', async ({ name, old, wire }) => {
    const path = join(migrationDirectory, `format-${String(format)}-${name}.json`)
    expectSinglePlayerMigration(old, migrateLegacyBrewingState(old))
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
    { name: 'fuel 1301 producing 65 powder', state: { fuelUnits: 1301 }, reason: 'legacy brewing fuel exceeds one stack' },
    { name: 'fuel 1319 producing 65 powder', state: { fuelUnits: 1319 }, reason: 'legacy brewing fuel exceeds one stack' },
    { name: 'fuel 1320 producing 65 powder', state: { fuelUnits: 1320 }, reason: 'legacy brewing fuel exceeds one stack' },
    { name: 'maximum fuel beyond one stack', state: { fuelUnits: Number.MAX_SAFE_INTEGER }, reason: 'legacy brewing fuel exceeds one stack' },
    { name: 'negative fuel', state: { fuelUnits: -1 }, reason: 'invalid legacy brewing state' },
    { name: 'fractional fuel', state: { fuelUnits: 0.5 }, reason: 'invalid legacy brewing state' },
    { name: 'missing fuel', state: {}, reason: 'invalid legacy brewing state' },
    { name: 'unknown potion', state: { fuelUnits: 0, bottle: { potion: 'unknown' } }, reason: 'invalid legacy brewing state' },
    { name: 'incompatible recipe', state: { fuelUnits: 0, bottle: 'water_bottle', ingredient: 'sugar' }, reason: 'invalid legacy brewing recipe' },
    { name: 'progress without bottle', state: { fuelUnits: 0, brewing: { output: 'speed', remainingSecs: 1 } }, reason: 'invalid legacy brewing progress' },
    { name: 'progress with ingredient', state: { fuelUnits: 0, bottle: 'water_bottle', ingredient: 'sugar', brewing: { output: 'speed', remainingSecs: 1 } }, reason: 'invalid legacy brewing progress' },
    { name: 'zero progress duration', state: { fuelUnits: 0, bottle: 'water_bottle', brewing: { output: 'speed', remainingSecs: 0 } }, reason: 'invalid legacy brewing state' },
  ])('returns a typed failure for $name without replacing the old file', async ({ name, state, reason }) => {
    const path = join(migrationDirectory, `format-${String(format)}-invalid-${name}.json`)
    if ('fuelUnits' in state && typeof state.fuelUnits === 'number' && state.fuelUnits > 1300) {
      expectSinglePlayerMigration(state, migrateLegacyBrewingState(state))
    }
    const source = JSON.stringify({ format, worldId, seed, state: { revision: 0, blocks: [], brewingStands: [{ at, state }] } })
    await writeFile(path, source, 'utf8')
    expect(await loadServerState(path, worldId, seed)).toEqual(Result.fail({ _tag: 'SavedServerStateFailure', path: 'brewingStands', reason, filePath: path }))
    expect(await readFile(path, 'utf8')).toBe(source)
  })

  it('matches single-player migration and preserves generated legacy brewing shapes through real file round trips', async () => {
    const path = join(migrationDirectory, `format-${String(format)}-property.json`)
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...oldShapes),
      fc.integer({ min: 0, max: 1319 }),
      fc.nat({ max: 100_000 }),
      async ({ old, wire }, fuelUnits, burnTicksRemaining) => {
        const stand = { ...old, fuelUnits }
        const migrated = migrateLegacyBrewingState(stand)
        expectSinglePlayerMigration(stand, migrated)
        const source = JSON.stringify({ ...envelope, state: {
          revision: 0, blocks: [], brewingStands: [{ at, state: stand }],
          furnaces: [{ ...legacyFurnace, burnTicksRemaining }],
        } })
        await writeFile(path, source, 'utf8')
        const loadedResult = await loadServerState(path, worldId, seed)
        if (Result.isFailure(migrated)) {
          expect(loadedResult).toEqual(Result.fail({ ...migrated.failure, filePath: path }))
          expect(await readFile(path, 'utf8')).toBe(source)
          return
        }
        const newWire = Result.getOrThrow(brewingStateToWire(migrated.success))
        expect(newWire.bottles).toEqual(wire.bottles)
        expect(newWire.ingredient).toEqual(wire.ingredient)
        expect(newWire.brewProgressSecs).toBe(0)
        expect(newWire.fuelCharges).toBe(Math.min(fuelUnits, 20))
        const powder = Math.ceil(Math.max(0, fuelUnits - 20) / 20)
        expect(newWire.fuel).toEqual(powder === 0 ? null : { item: 'blaze_powder', count: powder })
        const recovered = newWire.fuelCharges + (newWire.fuel === null ? 0 : newWire.fuel.count * 20)
        expect(recovered).toBeGreaterThanOrEqual(fuelUnits)
        expect(recovered - fuelUnits).toBeLessThan(20)
        const loaded = Result.getOrThrow(loadedResult)
        expect(loaded?.brewingStands).toEqual([{ at, state: migrated.success }])
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
    expect(await loadServerState(path, worldId, seed)).toEqual(Result.fail({ _tag: 'SavedServerStateFailure', path: 'brewingStands', reason: 'invalid-wire', filePath: path }))
  })

  it.each([
    { source: 'null', reason: 'invalid multiplayer state envelope', nested: false },
    { source: '{}', reason: 'multiplayer state file does not match world and seed or supported format', nested: false },
    { source: '{"format":3}', reason: 'multiplayer state file does not match world and seed or supported format', nested: false },
    { source: '{"format":3,"worldId":"migration-world","seed":7,"state":null}', reason: 'invalid saved server state', nested: true },
    { source: '{', reason: 'invalid multiplayer state JSON', nested: false },
  ])('returns a typed failure for malformed envelope $source', async ({ source, reason, nested }) => {
    const path = join(await mkdtemp(join(tmpdir(), 'server-envelope-invalid-')), 'state.json')
    await writeFile(path, source, 'utf8')
    expect(await loadServerState(path, worldId, seed)).toEqual(Result.fail({
      _tag: 'SavedServerStateFailure', path: nested ? 'state' : path, reason, filePath: path,
    }))
  })
})


describe.each([1, 2, 3])('format %s status effect ingress', (format) => {
  it.each([
    { name: 'unsupported visible effect', effects: [{ type: 'night_vision', amplifier: 0, remainingSecs: 30, pulseClockSecs: 0 }],
      reason: 'unsupported visible status effect type: night_vision' },
    { name: 'invalid visible effect', effects: [{ type: 'regeneration', amplifier: -1, remainingSecs: 30, pulseClockSecs: 0 }],
      reason: 'invalid status effect state' },
    { name: 'invalid hidden effect', effects: [{ type: 'regeneration', amplifier: 1, remainingSecs: 5, pulseClockSecs: 0,
      hiddenEffects: [{ amplifier: -1, remainingSecs: 30, pulseClockSecs: 0 }] }],
      reason: 'invalid status effect state' },
  ])('rejects $name before accepting a saved state', async ({ name, effects, reason }) => {
    const path = join(migrationDirectory, `format-${String(format)}-${name}.json`)
    const source = JSON.stringify({ format, worldId, seed, state: {
      revision: 0, blocks: [], statusEffects: [{ player: 'alice', state: { effects } }],
    } })
    await writeFile(path, source, 'utf8')
    expect(await loadServerState(path, worldId, seed)).toEqual(Result.fail({
      _tag: 'SavedServerStateFailure', path: 'statusEffects', reason, filePath: path,
    }))
    expect(await readFile(path, 'utf8')).toBe(source)
  })
})

describe('saved state filesystem diagnostics', () => {
  it('retains the real EISDIR error and requested file path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'server-read-directory-'))
    expect(await loadServerState(directory, worldId, seed)).toEqual(Result.fail({
      _tag: 'SavedServerStateFailure', path: directory, filePath: directory,
      reason: 'failed to read multiplayer state', code: 'EISDIR',
    }))
  })

  it('retains the real ENOTDIR error and requested file path', async () => {
    const parent = join(migrationDirectory, 'parent-file.json')
    await writeFile(parent, '{}', 'utf8')
    const path = join(parent, 'state.json')
    expect(await loadServerState(path, worldId, seed)).toEqual(Result.fail({
      _tag: 'SavedServerStateFailure', path, filePath: path,
      reason: 'failed to read multiplayer state', code: 'ENOTDIR',
    }))
  })
})
