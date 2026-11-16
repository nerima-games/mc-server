import { applyStatusEffect, emptyStatusEffectState, type StatusEffectType } from '@nerima-games/mx-gameplay'
import { statusEffectsToWire } from '../../apps/multiplayer-server/brewing-stands'
import { emptyBrewingState } from '@nerima-games/mc-sim'
import {
  BrewingCommand,
  CommandId,
  WorldId,
  decodeFrame,
  encodeFrame,
  PlayerId,
  PlayerJoin,
  PlayerVitalsCommand,
  type NetworkMessage,
  type WireText,
} from '@nerima-games/mx-multiplayer'
import { Result, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeMultiplayerServerCore, type MultiplayerServerState } from '../../apps/multiplayer-server/core'
import { makeMultiplayerServerCoreParts } from '../../apps/multiplayer-server/entrypoints/core-parts'
import { replicatedOwners } from './codec'
import { floorTerrain } from './terrain'

const airTerrain = floorTerrain(0, 'air')

const frame = (message: NetworkMessage): WireText => Result.getOrThrow(encodeFrame(message))
const messages = (frames: ReadonlyArray<WireText>): ReadonlyArray<NetworkMessage> =>
  frames.map((wire) => Result.getOrThrow(decodeFrame(wire, replicatedOwners)))

const visibleTypes: ReadonlyArray<StatusEffectType> = ['poison', 'regeneration', 'speed', 'hunger', 'nausea']

describe('visible status-effect wire state', () => {
  it.each(visibleTypes)('projects the visible %s fields without mutating authoritative state', (type) => {
    const state = Result.getOrThrow(applyStatusEffect(emptyStatusEffectState(), { type, durationSecs: 12, amplifier: 2 })).state
    const before = structuredClone(state)
    expect(statusEffectsToWire(state)).toEqual(Result.succeed({ effects: [{ type, remainingSecs: 12, pulseClockSecs: 0, amplifier: 2 }] }))
    expect(state).toEqual(before)
  })

  it('returns a typed failure for an authoritative effect outside the wire vocabulary', () => {
    const state = Result.getOrThrow(applyStatusEffect(emptyStatusEffectState(), { type: 'night_vision', durationSecs: 12 })).state
    expect(statusEffectsToWire(state)).toEqual(Result.fail({ _tag: 'UnsupportedVisibleStatusEffect', type: 'night_vision' }))
    expect(state.effects[0]?.type).toBe('night_vision')
  })
  it('rejects an unsupported initial effect before creating a server', () => {
    const player = PlayerId.make('alice')
    const state = Result.getOrThrow(applyStatusEffect(emptyStatusEffectState(), { type: 'night_vision', durationSecs: 12 })).state
    const result = makeMultiplayerServerCore({
      worldId: 'world-1', seed: 42, allowedBlocks: new Set(), spawnAt: { x: 0, y: 64, z: 0 },
      chunkSource: airTerrain, parts: makeMultiplayerServerCoreParts(),
      initialState: {
        revision: 0, blocks: [], inventories: [], vitals: [], timeWeather: { timeOfDay: 6000, weather: 'clear' },
        containers: [], furnaces: [], villagerTrades: [], statusEffects: [{ player, state }],
      },
    })
    expect(result).toEqual(Result.fail({ _tag: 'SavedServerStateFailure', path: 'statusEffects', reason: 'unsupported visible status effect type: night_vision' }))
  })

  it('rejects an unsupported realm-transfer effect before mutating destination state', () => {
    const makeServer = () => Result.getOrThrow(makeMultiplayerServerCore({
      worldId: 'world-1', seed: 42, allowedBlocks: new Set(), spawnAt: { x: 0, y: 64, z: 0 },
      chunkSource: airTerrain, parts: makeMultiplayerServerCoreParts(),
    }))
    const source = makeServer()
    const player = PlayerId.make('alice')
    expect(source.connect('source', () => {})).toBe(true)
    expect(source.receive('source', frame(Result.getOrThrow(Schema.decodeUnknownResult(PlayerJoin)({
      _tag: 'PlayerJoin', player, name: 'Alice', at: { x: 0, y: 64, z: 0 },
    })))).accepted).toBe(true)
    const transfer = Result.getOrThrow(source.detachPlayer('source'))
    if (transfer === undefined) throw new Error('missing detached player')
    const destination = makeServer()
    const sent: Array<WireText> = []
    expect(destination.connect('destination', (wire) => { sent.push(wire) })).toBe(true)
    const before = destination.snapshot()
    const frameCount = sent.length
    const state = Result.getOrThrow(applyStatusEffect(emptyStatusEffectState(), { type: 'night_vision', durationSecs: 12 })).state
    expect(destination.acceptRealmTransfer('destination', { ...transfer, statusEffects: state }, {
      commandId: CommandId.make('transfer'), fromWorld: WorldId.make('world-1'),
      at: { x: 0, y: 64, z: 0 }, facing: { yawRadians: 0, pitchRadians: 0 },
    }, Result.getOrThrow(destination.prepareRealmTransfer()))).toEqual(Result.fail({
      _tag: 'SavedServerStateFailure', path: 'statusEffects', reason: 'unsupported visible status effect type: night_vision',
    }))
    expect(destination.snapshot()).toEqual(before)
    expect(sent).toHaveLength(frameCount)
  })

  it('announces regeneration I in the tick regeneration II expires while retaining hidden effects on the server', () => {
    const player = Result.getOrThrow(Schema.decodeUnknownResult(PlayerId)('alice'))
    const at = { x: 1, y: 64, z: 0 }
    const initialState: MultiplayerServerState = {
      revision: 4,
      blocks: [{ at, block: 'brewing_stand' }],
      inventories: [{
        player,
        state: {
          slots: [
            { item: 'golden_apple', count: 1 },
            { item: 'potion_of_regeneration', count: 1 },
          ],
          selectedSlot: 0,
        },
      }],
      vitals: [{ player, state: { health: 3, hunger: 2, experience: 0 } }],
      timeWeather: { timeOfDay: 6_000, weather: 'clear' },
      containers: [],
      furnaces: [],
      villagerTrades: [],
      brewingStands: [{ at, state: Result.getOrThrow(emptyBrewingState()) }],
    }
    const sent: Array<WireText> = []
    const persisted: Array<MultiplayerServerState> = []
    const server = Result.getOrThrow(makeMultiplayerServerCore({
      worldId: 'world-1',
      seed: 42,
      allowedBlocks: new Set(['brewing_stand']),
      initialState,
      spawnAt: { x: 0, y: 64, z: 0 },
      chunkSource: airTerrain,
      parts: makeMultiplayerServerCoreParts(),
      onStateChanged: (state) => { persisted.push(state) },
    }))
    expect(server.connect('socket-a', (wire) => { sent.push(wire) })).toBe(true)
    const join = Result.getOrThrow(Schema.decodeUnknownResult(PlayerJoin)({
      _tag: 'PlayerJoin', player, name: 'Alice', at: { x: 0, y: 64, z: 0 },
    }))
    expect(server.receive('socket-a', frame(join)).accepted).toBe(true)
    sent.length = 0

    const eat = Result.getOrThrow(Schema.decodeUnknownResult(PlayerVitalsCommand)({
      _tag: 'PlayerVitalsCommand',
      commandId: 'eat-golden-apple',
      player,
      world: 'world-1',
      expectedRevision: 4,
      action: { _tag: 'eat', item: 'golden_apple' },
    }))
    expect(server.receive('socket-a', frame(eat)).accepted).toBe(true)
    expect(messages(sent).filter((message) => message._tag === 'PlayerStatusEffectsDelta')).toEqual([{
      _tag: 'PlayerStatusEffectsDelta',
      player,
      world: 'world-1',
      revision: 5,
      state: { effects: [{ type: 'regeneration', remainingSecs: 5, pulseClockSecs: 0, amplifier: 1 }] },
    }])
    sent.length = 0

    const drink = Result.getOrThrow(Schema.decodeUnknownResult(BrewingCommand)({
      _tag: 'BrewingCommand',
      commandId: 'drink-regeneration',
      player,
      world: 'world-1',
      expectedRevision: 5,
      at,
      action: { _tag: 'drink', slot: 1 },
    }))
    expect(server.receive('socket-a', frame(drink)).accepted).toBe(true)
    expect(persisted.at(-1)?.statusEffects).toEqual([{
      player,
      state: {
        effects: [{
          type: 'regeneration', remainingSecs: 5, pulseClockSecs: 0, amplifier: 1,
          hiddenEffects: [{ remainingSecs: 45, pulseClockSecs: 0, amplifier: 0 }],
        }],
      },
    }])
    expect(messages(sent).filter((message) => message._tag === 'PlayerStatusEffectsDelta')).toEqual([{
      _tag: 'PlayerStatusEffectsDelta',
      player,
      world: 'world-1',
      revision: 6,
      state: { effects: [{ type: 'regeneration', remainingSecs: 5, pulseClockSecs: 0, amplifier: 1 }] },
    }])

    expect(server.tick(4_000)).toEqual(Result.succeed({ refusals: [] }))
    expect(persisted.at(-1)?.statusEffects).toEqual([{
      player,
      state: {
        effects: [{
          type: 'regeneration', remainingSecs: 1, pulseClockSecs: 0.25, amplifier: 1,
          hiddenEffects: [{ remainingSecs: 41, pulseClockSecs: 1.5, amplifier: 0 }],
        }],
      },
    }])
    sent.length = 0

    expect(server.tick(1_000)).toEqual(Result.succeed({ refusals: [] }))
    const resumed = { effects: [{ type: 'regeneration', remainingSecs: 40, pulseClockSecs: 0, amplifier: 0 }] }
    expect(persisted.at(-1)?.statusEffects).toEqual([{ player, state: resumed }])
    const deltas = messages(sent).filter((message) => message._tag === 'PlayerStatusEffectsDelta')
    expect(deltas).toEqual([{
      _tag: 'PlayerStatusEffectsDelta',
      player,
      world: 'world-1',
      revision: persisted.at(-1)?.revision,
      state: resumed,
    }])
  })
})
