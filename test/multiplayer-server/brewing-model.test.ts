import { DeltaTimeSecs, WorldIdSchema } from '@nerima-games/mc-kernel'
import {
  brewingState, emptyBrewingState, itemStack, makeBrewingService,
  makeBrewingServiceRegistration, makeWorldCommitCoordinator,
  ReplicatedOwnerIdSchema, WorldCommitCoordinator, type BrewingState,
  addItem, emptyInventory, storageFromInventory, PotionDrinkIntentSchema, PotionDrinkInventorySnapshotSchema,
} from '@nerima-games/mc-sim'
import {
  BrewingCommand, CommandId, PlayerId, PlayerName, Revision, WorldId,
  brewingStateFromWire, brewingStateToWire, decodeFrame, encodeFrame,
  furnaceStateFromWire, furnaceStateToWire, type BrewingAction,
  FurnaceStateWire, type NetworkMessage,
} from '@nerima-games/mx-multiplayer'
import { applyStatusEffect, emptyStatusEffectState, statusEffectOfPotion, tickStatusEffects } from '@nerima-games/mx-gameplay'
import { Effect, Result, Schema } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { makeMultiplayerServerCore, type MultiplayerServerState } from '../../apps/multiplayer-server/core'
import { makeMultiplayerServerCoreParts } from '../../apps/multiplayer-server/entrypoints/core-parts'
import { replicatedOwners } from './codec'
import { floorTerrain } from './terrain'

const player = Schema.decodeUnknownSync(PlayerId)('brewer')
const world = Schema.decodeUnknownSync(WorldId)('world-1')
const at = { x: 0, y: 64, z: -1 }
const stack = (item: Parameters<typeof itemStack>[0], count = 1) => Result.getOrThrow(itemStack(item, count))
const roundTrip = (message: NetworkMessage): NetworkMessage =>
  Result.getOrThrow(decodeFrame(Result.getOrThrow(encodeFrame(message)), replicatedOwners))

const bottleArbitrary = fc.constantFrom(
  stack('water_bottle'), stack('awkward_potion'), stack('potion_of_swiftness'),
  stack('potion_of_poison'), stack('potion_of_regeneration'),
)
const wireRevision = Schema.decodeUnknownSync(Revision)(7)
const decodeFurnaceWire = Schema.decodeUnknownSync(FurnaceStateWire)
const potionCases: ReadonlyArray<Readonly<{
  potion: Exclude<Parameters<typeof statusEffectOfPotion>[0], 'awkward'>
  item: Parameters<typeof itemStack>[0]
  durationSecs: number
}>> = [
  { potion: 'speed', item: 'potion_of_swiftness', durationSecs: 180 },
  { potion: 'poison', item: 'potion_of_poison', durationSecs: 45 },
  { potion: 'regeneration', item: 'potion_of_regeneration', durationSecs: 45 },
]
const brewingArbitrary = fc.record({
  first: bottleArbitrary,
  second: fc.option(bottleArbitrary, { nil: undefined }),
  third: fc.option(bottleArbitrary, { nil: undefined }),
  ingredient: fc.option(fc.constantFrom('nether_wart', 'sugar', 'spider_eye', 'ghast_tear'), { nil: undefined }),
  ingredientCount: fc.integer({ min: 1, max: 64 }),
  fuelCount: fc.integer({ min: 0, max: 64 }),
  fuelCharges: fc.integer({ min: 0, max: 20 }),
  brewProgressSecs: fc.double({ min: 0, max: 19.999999999999996, noNaN: true }),
}).map((value) => Result.getOrThrow(brewingState({
  bottles: [
    value.first,
    value.second,
    value.third,
  ],
  ingredient: value.ingredient === undefined ? undefined : stack(value.ingredient, value.ingredientCount),
  fuel: value.fuelCount === 0 ? undefined : stack('blaze_powder', value.fuelCount),
  fuelCharges: value.fuelCharges,
  brewProgressSecs: value.brewProgressSecs,
})))

describe('brewing model and protocol 12 state contracts', () => {
  it.each(potionCases)('matches the single-player drink effect and timing for $potion', async ({ potion, item, durationSecs }) => {
    const service = await Effect.runPromise(makeBrewingService(
      Schema.decodeUnknownSync(ReplicatedOwnerIdSchema)('potion-effects'),
    ))
    const inventory = Result.getOrThrow(addItem(emptyInventory(), item, 1)).inventory
    const snapshot = Schema.decodeUnknownSync(PotionDrinkInventorySnapshotSchema)({
      world: 'world-1', expectedRevision: 0, expectedDimensions: [],
      state: storageFromInventory(inventory),
    })
    const intent = Schema.decodeUnknownSync(PotionDrinkIntentSchema)({
      inventoryOwnerId: 'inventory', actor: 'brewer', slotIndex: 0, tick: 0,
    })
    const plan = await Effect.runPromise(service.planDrinkPotion(snapshot, intent))
    expect(plan.result._tag).toBe('Consumed')
    if (plan.result._tag !== 'Consumed') throw new Error('effect-bearing potion was not consumed')
    const singlePlayerEffect = plan.result.effect
    const serverEffect = statusEffectOfPotion(potion)
    expect(serverEffect).toBeDefined()
    if (serverEffect === undefined) throw new Error('effect-bearing potion has no server application')
    expect(serverEffect.type).toBe(singlePlayerEffect.type)
    expect(serverEffect.durationSecs).toBe(singlePlayerEffect.durationSecs)
    expect(singlePlayerEffect).toStrictEqual({ type: potion, durationSecs, amplifier: 0 })

    let serverState = Result.getOrThrow(applyStatusEffect(emptyStatusEffectState(), serverEffect)).state
    let singlePlayerState = Result.getOrThrow(applyStatusEffect(emptyStatusEffectState(), singlePlayerEffect)).state
    expect(serverState).toStrictEqual(singlePlayerState)
    expect(serverState.effects).toStrictEqual([{
      type: potion, remainingSecs: durationSecs, pulseClockSecs: 0, amplifier: 0,
    }])
    let elapsedSecs = 0
    let pulses = 0
    for (const stepSecs of [0.5, durationSecs - 1, 0.5]) {
      const dt = Result.getOrThrow(DeltaTimeSecs.result(stepSecs))
      const serverTick = Result.getOrThrow(tickStatusEffects(serverState, dt))
      const singlePlayerTick = Result.getOrThrow(tickStatusEffects(singlePlayerState, dt))
      expect(serverTick).toStrictEqual(singlePlayerTick)
      elapsedSecs += stepSecs
      serverState = serverTick.state
      singlePlayerState = singlePlayerTick.state
      if (elapsedSecs < durationSecs) {
        expect(serverState.effects[0]?.remainingSecs).toBe(durationSecs - elapsedSecs)
      } else {
        expect(serverState.effects).toStrictEqual([])
      }
      pulses += serverTick.poisonPulses + serverTick.regenerationPulses
    }
    if (potion === 'speed') expect(pulses).toBe(0)
    else expect(pulses).toBeGreaterThan(0)
  })

  it('matches the real coordinator-backed BrewingService after each accepted server operation', async () => {
    const initial = Result.getOrThrow(emptyBrewingState())
    const ownerId = Schema.decodeUnknownSync(ReplicatedOwnerIdSchema)('brewing-test')
    const registration = Result.getOrThrow(makeBrewingServiceRegistration(ownerId, initial))
    const coordinator = await Effect.runPromise(makeWorldCommitCoordinator({
      world: Schema.decodeUnknownSync(WorldIdSchema)('world-1'), owners: [registration],
    }))
    const service = await Effect.runPromise(makeBrewingService(ownerId))
    const run = <A, E>(effect: Effect.Effect<A, E, WorldCommitCoordinator>) =>
      Effect.runPromise(Effect.provideService(effect, WorldCommitCoordinator, coordinator))
    let saved: MultiplayerServerState = {
      revision: 0, blocks: [], containers: [], furnaces: [], vitals: [], villagerTrades: [],
      timeWeather: { timeOfDay: 6_000, weather: 'clear' },
      inventories: [{
        player,
        state: { slots: [{ item: 'water_bottle', count: 1 }, { item: 'water_bottle', count: 1 }, { item: 'water_bottle', count: 1 }, { item: 'nether_wart', count: 2 }, { item: 'blaze_powder', count: 1 }], selectedSlot: 0 },
      }],
      brewingStands: [{ at, state: initial }],
    }
    const core = Result.getOrThrow(makeMultiplayerServerCore({
      worldId: 'world-1', seed: 42, allowedBlocks: new Set(['stone']),
      bounds: { minX: -10, maxX: 10, minY: 0, maxY: 100, minZ: -10, maxZ: 10 },
      spawnAt: { x: 0, y: 64, z: 0 },
      chunkSource: floorTerrain(0, 'air', [{ at, block: 'brewing_stand' }]),
      parts: makeMultiplayerServerCoreParts(), initialState: saved,
      onStateChanged: (state) => { saved = state },
    }))
    expect(core.connect('client', () => {})).toBe(true)
    expect(core.receive('client', Result.getOrThrow(encodeFrame({
      _tag: 'PlayerJoin', player, name: Schema.decodeUnknownSync(PlayerName)('brewer'), at: { x: 0, y: 64, z: 0 },
    }))).accepted).toBe(true)
    let commandIndex = 0
    const command = (action: BrewingAction) => {
      commandIndex += 1
      const message = Schema.decodeUnknownSync(BrewingCommand)({
        _tag: 'BrewingCommand', action, at, player, world,
        commandId: Schema.decodeUnknownSync(CommandId)(`brew-${String(commandIndex)}`),
        expectedRevision: Schema.decodeUnknownSync(Revision)(core.snapshot().revision),
      })
      expect(core.receive('client', Result.getOrThrow(encodeFrame(message))).accepted).toBe(true)
    }
    const assertSame = async () => {
      const stand = saved.brewingStands?.find((entry) => entry.at.x === at.x && entry.at.y === at.y && entry.at.z === at.z)
      expect(stand).toBeDefined()
      if (stand === undefined) throw new Error('accepted brewing operation did not preserve its stand')
      expect(stand.state).toStrictEqual(await run(service.snapshot))
    }
    await assertSame()
    for (const index of [0, 1, 2]) {
      const action = Schema.decodeUnknownSync(BrewingCommand)({
        _tag: 'BrewingCommand', action: { _tag: 'insert-bottle', slot: index, bottleIndex: index },
        at, player, world, commandId: 'unused', expectedRevision: 0,
      }).action
      command(action)
      await run(service.setBottle(index, stack('water_bottle')))
      await assertSame()
    }
    command({ _tag: 'insert-ingredient', slot: 3 })
    await run(service.setIngredient(stack('nether_wart')))
    await assertSame()
    expect(saved.inventories.find((entry) => entry.player === player)?.state.slots[3]).toStrictEqual({ item: 'nether_wart', count: 1 })
    command({ _tag: 'insert-fuel', slot: 4 })
    await run(service.setFuel(stack('blaze_powder')))
    await run(service.addFuel)
    await assertSame()
    Result.getOrThrow(core.tick(20_000))
    await run(service.advance(20))
    await assertSame()
    const brewed: BrewingState = await run(service.snapshot)
    expect(brewed.bottles.map((bottle) => bottle?.item)).toStrictEqual(['awkward_potion', 'awkward_potion', 'awkward_potion'])
    command({ _tag: 'collect', bottleIndex: 1 })
    await run(service.setBottle(1, undefined))
    await assertSame()
    const inventory = saved.inventories.find((entry) => entry.player === player)
    expect(inventory?.state.slots.filter((slot) => slot?.item === 'awkward_potion')).toStrictEqual([{ item: 'awkward_potion', count: 1 }])
  })

  it('round-trips generated nonempty three-bottle kernel state through the versioned codec', () => {
    fc.assert(fc.property(brewingArbitrary, (state) => {
      const wire = Result.getOrThrow(brewingStateToWire(state))
      const decoded = roundTrip({
        _tag: 'BrewingStandDelta', world, at,
        revision: wireRevision, state: wire,
      })
      expect(decoded._tag).toBe('BrewingStandDelta')
      if (decoded._tag !== 'BrewingStandDelta') throw new Error('codec changed the message tag')
      expect(decoded.state).toStrictEqual(wire)
      expect(Result.getOrThrow(brewingStateFromWire(decoded.state))).toStrictEqual(state)
    }), { numRuns: 100 })
  })

  it.each(['furnace', 'blast_furnace', 'smoker'])('round-trips generated %s state with total burn time and stacks', (station) => {
    fc.assert(fc.property(fc.record({
      burnTicksRemaining: fc.integer({ min: 0, max: 10_000 }),
      extraBurnTicks: fc.integer({ min: 0, max: 10_000 }),
      cookTicks: fc.integer({ min: 0, max: 99 }),
      inputCount: fc.integer({ min: 1, max: 64 }),
      fuelCount: fc.integer({ min: 1, max: 64 }),
      outputCount: fc.integer({ min: 1, max: 64 }),
    }), (value) => {
      const wire: FurnaceStateWire = decodeFurnaceWire({
        furnaceId: '0,64,-1', station,
        burnTicksRemaining: value.burnTicksRemaining,
        burnTicksTotal: value.burnTicksRemaining + value.extraBurnTicks,
        cookTicks: value.cookTicks,
        input: { item: station === 'smoker' ? 'beef' : 'iron_ore', count: value.inputCount },
        fuel: { item: 'coal', count: value.fuelCount },
        output: { item: station === 'smoker' ? 'cooked_beef' : 'iron_ingot', count: value.outputCount },
      })
      const decoded = roundTrip({ _tag: 'FurnaceDelta', world, revision: wireRevision, state: wire })
      expect(decoded._tag).toBe('FurnaceDelta')
      if (decoded._tag !== 'FurnaceDelta') throw new Error('codec changed the message tag')
      expect(decoded.state).toStrictEqual(wire)
      const kernel = Result.getOrThrow(furnaceStateFromWire(decoded.state))
      expect(kernel.station).toBe(station)
      expect(Result.getOrThrow(furnaceStateToWire(kernel, wire.furnaceId))).toStrictEqual(wire)
    }), { numRuns: 100 })
  })
})
