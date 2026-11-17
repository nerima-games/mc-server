import { describe, expect, it } from 'vitest'
import { Result, Schema } from 'effect'
import { brewingState, itemStack } from '@nerima-games/mc-sim'
import { EncodedBlockStateSchema, type BrewingState } from '@nerima-games/mc-kernel'
import { BrewingStandState, CommandId, PlayerId, PlayerName, WorldId, brewingStateFromWire, decodeFrame, encodeFrame, type BrewingAction, type NetworkMessage, type WireText } from '@nerima-games/mx-multiplayer'
import { makeMultiplayerServerCore, type MultiplayerServerState } from '../../apps/multiplayer-server/core'
import { makeMultiplayerServerCoreParts } from '../../apps/multiplayer-server/entrypoints/core-parts'
import { floorTerrain } from './terrain'
import { replicatedOwners } from './codec'

const at = { x: 1, y: 64, z: 0 }
const alice = Schema.decodeUnknownSync(PlayerId)('alice')
const world = Schema.decodeUnknownSync(WorldId)('world-1')
const stack = (item: Parameters<typeof itemStack>[0], count = 1) => Result.getOrThrow(itemStack(item, count))
const stand = (input: Parameters<typeof brewingState>[0] = {}) => Result.getOrThrow(brewingState(input))
const water = stack('water_bottle')
const defaultSlots: MultiplayerServerState['inventories'][number]['state']['slots'] = [
  { item: 'water_bottle', count: 1 }, { item: 'water_bottle', count: 1 }, { item: 'nether_wart', count: 2 },
  { item: 'blaze_powder', count: 2 }, { item: 'potion_of_regeneration', count: 1 },
  ...Array.from({ length: 31 }, () => null),
]

const fixture = (state = stand(), metadata: Partial<MultiplayerServerState> = {}, block: 'brewing_stand' | 'air' | 'furnace' = 'brewing_stand') => {
  const initial: MultiplayerServerState = {
    revision: 0, blocks: [], inventories: [{ player: alice, state: { slots: defaultSlots, selectedSlot: 0 } }],
    vitals: [], timeWeather: { timeOfDay: 6000, weather: 'clear' }, containers: [], furnaces: [], villagerTrades: [],
    brewingStands: [{ at, state }], ...metadata,
  }
  const saves: Array<MultiplayerServerState> = []
  const frames: Array<WireText> = []
  const server = Result.getOrThrow(makeMultiplayerServerCore({
    worldId: 'world-1', dimension: 'overworld', seed: 42,
    allowedBlocks: new Set(['brewing_stand', 'furnace']), bounds: { minX: -10, maxX: 10, minY: 0, maxY: 100, minZ: -10, maxZ: 10 },
    spawnAt: { x: 0, y: 64, z: 0 }, chunkSource: floorTerrain(0, 'air', block === 'air' ? [] : [{ at, block }]),
    parts: makeMultiplayerServerCoreParts(), initialState: initial, onStateChanged: (saved) => saves.push(saved),
  }))
  const send = (message: NetworkMessage) => server.receive('a', Result.getOrThrow(encodeFrame(message, replicatedOwners)))
  const connect = (socket = 'a', player = alice) => {
    expect(server.connect(socket, (frame) => frames.push(frame))).toBe(true)
    expect(server.receive(socket, Result.getOrThrow(encodeFrame({ _tag: 'PlayerJoin', player, name: Schema.decodeUnknownSync(PlayerName)(String(player)), at: { x: 0, y: 64, z: 0 } }, replicatedOwners))).accepted).toBe(true)
  }
  connect()
  let id = 0
  const command = (action: BrewingAction) => {
    id += 1
    return send({ _tag: 'BrewingCommand', commandId: CommandId.make(`brew-${String(id)}`), player: alice, world, expectedRevision: server.snapshot().revision, at, action })
  }
  const saved = () => saves.at(-1) ?? initial
  const network = () => frames.flatMap((frame) => {
    const decoded = decodeFrame(frame, replicatedOwners)
    return Result.isSuccess(decoded) ? [decoded.success] : []
  })
  const delta = () => {
    const found = network().reverse().find((message) => message._tag === 'BrewingStandDelta')
    if (found === undefined || found._tag !== 'BrewingStandDelta') throw new Error('missing protocol brewing delta')
    expect(Result.getOrThrow(brewingStateFromWire(found.state))).toEqual(saved().brewingStands?.[0]?.state)
    return found
  }
  frames.length = 0
  return { server, send, command, frames, network, connect, saved, delta }
}

type ActionTag = BrewingAction['_tag']
const actions: ReadonlyArray<BrewingAction> = [
  { _tag: 'open' }, { _tag: 'insert-bottle', slot: 0, bottleIndex: 0 }, { _tag: 'insert-ingredient', slot: 2 },
  { _tag: 'insert-fuel', slot: 3 }, { _tag: 'collect', bottleIndex: 0 }, { _tag: 'drink', slot: 4 },
]
const cases: ReadonlyArray<{ name: string; state: BrewingState; accepted: ReadonlyArray<ActionTag> }> = [
  { name: 'empty', state: stand(), accepted: ['open', 'insert-bottle', 'insert-ingredient', 'insert-fuel', 'drink'] },
  { name: 'one bottle', state: stand({ bottles: [water, undefined, undefined] }), accepted: ['open', 'insert-ingredient', 'insert-fuel', 'collect', 'drink'] },
  { name: 'three bottles', state: stand({ bottles: [water, water, water] }), accepted: ['open', 'insert-ingredient', 'insert-fuel', 'collect', 'drink'] },
  { name: 'brewing', state: stand({ bottles: [water, water, water], ingredient: stack('nether_wart'), fuelCharges: 19, brewProgressSecs: 5 }), accepted: ['open', 'insert-fuel', 'collect', 'drink'] },
  { name: 'ingredient occupied', state: stand({ ingredient: stack('nether_wart') }), accepted: ['open', 'insert-bottle', 'insert-fuel', 'drink'] },
  { name: 'zero charges with fuel', state: stand({ fuel: stack('blaze_powder', 2), fuelCharges: 0 }), accepted: ['open', 'insert-bottle', 'insert-ingredient', 'insert-fuel', 'drink'] },
  { name: 'twenty charges', state: stand({ fuelCharges: 20 }), accepted: ['open', 'insert-bottle', 'insert-ingredient', 'drink'] },
  { name: 'fuel occupied by another item', state: stand({ fuel: stack('coal') }), accepted: ['open', 'insert-bottle', 'insert-ingredient', 'drink'] },
]

describe('protocol 12 brewing commands', () => {
  for (const entry of cases) for (const action of actions) {
    it(`${entry.name}: ${action._tag}`, () => {
      const f = fixture(entry.state)
      const before = f.saved()
      const accepted = entry.accepted.includes(action._tag)
      expect(f.command(action).accepted).toBe(accepted)
      const response = f.network().reverse().find((message) => message._tag === 'BrewingCommandAccepted' || message._tag === 'BrewingCommandRejected')
      expect(response?._tag).toBe(accepted ? 'BrewingCommandAccepted' : 'BrewingCommandRejected')
      if (accepted) f.delta()
      else expect(f.saved()).toEqual(before)
    })
  }

  it('brews three indexed bottles and collects only the named bottle', () => {
    const f = fixture(stand(), { inventories: [{ player: alice, state: { slots: [{ item: 'water_bottle', count: 1 }, { item: 'water_bottle', count: 1 }, { item: 'water_bottle', count: 1 }, { item: 'nether_wart', count: 1 }, { item: 'blaze_powder', count: 1 }], selectedSlot: 0 } }] })
    for (const bottleIndex of [0, 1, 2]) expect(f.command({ _tag: 'insert-bottle', slot: bottleIndex, bottleIndex }).accepted).toBe(true)
    expect(f.command({ _tag: 'insert-ingredient', slot: 3 }).accepted).toBe(true)
    expect(f.command({ _tag: 'insert-fuel', slot: 4 }).accepted).toBe(true)
    expect(Result.isSuccess(f.server.tick(20_000))).toBe(true)
    expect(f.saved().brewingStands?.[0]?.state.bottles.map((bottle) => bottle?.item)).toEqual(['awkward_potion', 'awkward_potion', 'awkward_potion'])
    expect(f.command({ _tag: 'collect', bottleIndex: 1 }).accepted).toBe(true)
    expect(f.saved().brewingStands?.[0]?.state.bottles.map((bottle) => bottle?.item)).toEqual(['awkward_potion', undefined, 'awkward_potion'])
    expect(f.saved().inventories[0]?.state.slots).toContainEqual({ item: 'awkward_potion', count: 1 })
    f.delta()
  })

  it.each([0, 1, 2])('refuses occupied bottle index %i without consuming inventory', (bottleIndex) => {
    const f = fixture(stand({ bottles: [water, water, water] }))
    const before = f.saved()
    expect(f.command({ _tag: 'insert-bottle', slot: 0, bottleIndex }).accepted).toBe(false)
    expect(f.saved()).toEqual(before)
  })

  for (const kind of ['named', 'enchanted']) for (const action of actions.filter((action) => action._tag.startsWith('insert-'))) {
    it(`rejects ${kind} inventory metadata for ${action._tag}`, () => {
      if (!('slot' in action)) throw new Error('insert action has no source slot')
      const f = fixture(stand(), kind === 'named'
        ? { anvilNames: [{ player: alice, names: [{ slot: action.slot, name: 'Keepsake' }] }] }
        : { enchantments: [{ player: alice, seed: 1, items: [{ slot: action.slot, item: { item: 'water_bottle', durability: null, enchantments: [] } }] }] })
      const before = f.saved()
      expect(f.command(action).accepted).toBe(false)
      expect(f.network()).toContainEqual(expect.objectContaining({ _tag: 'BrewingCommandRejected', reason: 'invalid-command' }))
      expect(f.saved()).toEqual(before)
    })
  }

  it('rejects collection with a full inventory without removing the bottle', () => {
    const f = fixture(stand({ bottles: [water, undefined, undefined] }), { inventories: [{ player: alice, state: { slots: Array.from({ length: 36 }, () => ({ item: 'stone', count: 64 })), selectedSlot: 0 } }] })
    const before = f.saved()
    expect(f.command({ _tag: 'collect', bottleIndex: 0 }).accepted).toBe(false)
    expect(f.network()).toContainEqual(expect.objectContaining({ _tag: 'BrewingCommandRejected', reason: 'no-room' }))
    expect(f.saved()).toEqual(before)
  })

  it('rejects a full fuel stack without consuming inventory', () => {
    const f = fixture(stand({ fuel: stack('blaze_powder', 64) }))
    const before = f.saved()
    const result = f.command({ _tag: 'insert-fuel', slot: 3 })
    expect(result.accepted).toBe(false)
    if (result.accepted) throw new Error('full fuel stack accepted')
    expect(result.failure).toBeUndefined()
    expect(f.network()).toContainEqual(expect.objectContaining({ _tag: 'BrewingCommandRejected', reason: 'invalid-command' }))
    expect(f.saved()).toEqual(before)
  })

  it.each([5, 2])('rejects a non-potion or empty inventory slot %i', (slot) => {
    const f = fixture()
    const before = f.saved()
    expect(f.command({ _tag: 'drink', slot }).accepted).toBe(false)
    expect(f.saved()).toEqual(before)
  })

  it('drinks inventory potion, returns a glass bottle and leaves stand bottles intact', () => {
    const f = fixture(stand({ bottles: [water, undefined, undefined] }))
    expect(f.command({ _tag: 'drink', slot: 4 }).accepted).toBe(true)
    expect(f.saved().brewingStands?.[0]?.state.bottles[0]).toEqual(water)
    expect(f.saved().inventories[0]?.state.slots).toContainEqual({ item: 'glass_bottle', count: 1 })
    expect(f.saved().statusEffects?.[0]?.state.effects).toContainEqual({ type: 'regeneration', amplifier: 0, remainingSecs: 45, pulseClockSecs: 0 })
  })

  it.each([1, 2])('consumes named enchanted potion metadata only after the final item (%i remaining before drinking)', (count) => {
    const f = fixture(stand(), {
      inventories: [{ player: alice, state: { slots: [null, null, null, null, { item: 'potion_of_regeneration', count }, ...Array.from({ length: 31 }, () => null)], selectedSlot: 0 } }],
      anvilNames: [{ player: alice, names: [{ slot: 4, name: 'Tonic' }] }],
      enchantments: [{ player: alice, seed: 1, items: [{ slot: 4, item: { item: 'potion_of_regeneration', durability: null, enchantments: [] } }] }],
    })
    expect(f.command({ _tag: 'drink', slot: 4 }).accepted).toBe(true)
    const saved = f.saved()
    expect(saved.inventories[0]?.state.slots).toContainEqual({ item: 'glass_bottle', count: 1 })
    const names = saved.anvilNames?.flatMap(({ names }) => names)
    const enchanted = saved.enchantments?.flatMap(({ items }) => items)
    if (count === 1) {
      expect(names).not.toContainEqual({ slot: 4, name: 'Tonic' })
      expect(enchanted?.some(({ slot }) => slot === 4)).toBe(false)
    } else {
      expect(saved.inventories[0]?.state.slots[4]).toEqual({ item: 'potion_of_regeneration', count: 1 })
      expect(names).toContainEqual({ slot: 4, name: 'Tonic' })
      expect(enchanted?.some(({ slot }) => slot === 4)).toBe(true)
    }
  })

  it('routes open, operation, tick and join through the versioned converter', () => {
    const f = fixture(stand({ bottles: [water, water, water], ingredient: stack('nether_wart'), fuelCharges: 20 }))
    expect(f.command({ _tag: 'open' }).accepted).toBe(true)
    f.delta()
    expect(f.command({ _tag: 'collect', bottleIndex: 2 }).accepted).toBe(true)
    f.delta()
    expect(Result.isSuccess(f.server.tick(350))).toBe(true)
    const partial = f.delta()
    expect(partial.state.brewProgressSecs).toBeCloseTo(0.35)
    f.frames.length = 0
    f.connect('b', Schema.decodeUnknownSync(PlayerId)('bob'))
    const joined = f.delta()
    expect(joined.state.brewProgressSecs).toBe(partial.state.brewProgressSecs)
    expect(joined.state.fuelCharges).toBe(partial.state.fuelCharges)
  })

  it('routes placement and break through protocol 12 and drops all five stacks', () => {
    const f = fixture(stand(), { brewingStands: [], inventories: [{ player: alice, state: { slots: [{ item: 'brewing_stand', count: 1 }], selectedSlot: 0 } }] }, 'air')
    expect(f.send({ _tag: 'BlockPlace', player: alice, at, block: 'brewing_stand', state: Schema.decodeUnknownSync(EncodedBlockStateSchema)(0) }).accepted).toBe(true)
    f.delta()
    expect(f.send({ _tag: 'BlockBreak', player: alice, at }).accepted).toBe(true)
    const broken = f.network().reverse().find((message) => message._tag === 'BrewingStandDelta')
    expect(broken).toMatchObject({ state: { bottles: [null, null, null], ingredient: null, fuel: null, fuelCharges: 0, brewProgressSecs: 0 } })
    const full = fixture(stand({ bottles: [water, stack('awkward_potion'), stack('potion_of_poison')], ingredient: stack('nether_wart', 2), fuel: stack('blaze_powder', 3), fuelCharges: 8 }))
    expect(full.send({ _tag: 'BlockBreak', player: alice, at }).accepted).toBe(true)
    const drops = full.network().flatMap((message) => message._tag === 'EntitySpawnDelta' && message.entity._tag === 'item-drop' ? [message.entity.stack] : [])
    for (const expected of [{ item: 'water_bottle', count: 1 }, { item: 'awkward_potion', count: 1 }, { item: 'potion_of_poison', count: 1 }, { item: 'nether_wart', count: 2 }, { item: 'blaze_powder', count: 3 }]) expect(drops).toContainEqual(expected)
  })

  it('rejects protocol 11 brewing frames before executing any action', () => {
    const f = fixture()
    const before = f.saved()
    const raw = JSON.stringify({ protocolVersion: 11, message: { _tag: 'BrewingCommand', commandId: 'old', player: alice, world, expectedRevision: 0, at, action: { _tag: 'open' } } })
    const wire = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand('WireText')))(raw)
    expect(f.server.receive('a', wire).accepted).toBe(false)
    expect(f.saved()).toEqual(before)
  })

  it('rejects malformed three-bottle wire state', () => {
    expect(Result.isFailure(Schema.decodeUnknownResult(BrewingStandState)({ bottles: [null, null], ingredient: null, fuel: null, fuelCharges: 0, brewProgressSecs: 0 }))).toBe(true)
  })
})
