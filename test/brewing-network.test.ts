import type { WireText } from '@nerima-games/mx-multiplayer'
import { emptyBrewingStandState, emptyStatusEffectState } from '@nerima-games/mx-gameplay'
import { describe, expect, it } from 'vitest'

import { decodeBrewingWireMessage, encodeBrewingCommand } from '../apps/multiplayer-shared/brewing-network'

const wire = (value: unknown): WireText => JSON.stringify(value) as WireText

const command = {
  _tag: 'BrewingCommand',
  commandId: 'brew-1',
  player: 'alice',
  world: 'world-1',
  expectedRevision: 4,
  at: { x: 12, y: 64, z: -8 },
  action: { _tag: 'insert', slot: 5 },
} as const

describe('brewing wire codec', () => {
  it('decodes a valid command', () => {
    expect(decodeBrewingWireMessage(wire(command))).toEqual(command)
  })

  it('encodes commands as protocol frames that decode back to the same command', () => {
    const encoded = encodeBrewingCommand(command)

    expect(encoded).toBe('{"_tag":"BrewingCommand","commandId":"brew-1","player":"alice","world":"world-1","expectedRevision":4,"at":{"x":12,"y":64,"z":-8},"action":{"_tag":"insert","slot":5}}')
    expect(decodeBrewingWireMessage(encoded)).toEqual(command)
  })

  it.each(['open', 'collect', 'drink'] as const)('accepts the %s action without extra fields', (_tag) => {
    const message = { ...command, action: { _tag } }
    expect(decodeBrewingWireMessage(wire(message))).toEqual(message)
  })

  it.each([
    ['non-integer coordinate', { ...command, at: { ...command.at, x: 1.5 } }],
    ['invalid vertical coordinate', { ...command, at: { ...command.at, y: 30_000_001 } }],
    ['out-of-range coordinate', { ...command, at: { ...command.at, z: 30_000_001 } }],
    ['invalid slot', { ...command, action: { _tag: 'insert', slot: 36 } }],
    ['unknown action', { ...command, action: { _tag: 'discard' } }],
    ['non-object action', { ...command, action: null }],
    ['extra command field', { ...command, extra: true }],
  ])('rejects %s', (_case, message) => {
    expect(decodeBrewingWireMessage(wire(message))).toBeUndefined()
  })

  it('rejects malformed and oversized frames', () => {
    expect(decodeBrewingWireMessage('not-json' as WireText)).toBeUndefined()
    expect(decodeBrewingWireMessage(wire(null))).toBeUndefined()
    expect(decodeBrewingWireMessage('x'.repeat(8_193) as WireText)).toBeUndefined()
    expect(decodeBrewingWireMessage(wire({ ...command, at: null }))).toBeUndefined()
  })

  it('decodes accepted and rejected results', () => {
    expect(decodeBrewingWireMessage(wire({
      _tag: 'BrewingCommandResult', commandId: 'brew-1', accepted: true, revision: 5,
    }))).toEqual({ _tag: 'BrewingCommandResult', commandId: 'brew-1', accepted: true, revision: 5 })
    expect(decodeBrewingWireMessage(wire({
      _tag: 'BrewingCommandResult', commandId: 'brew-1', accepted: false, revision: 4, reason: 'missing-ingredients',
    }))).toEqual({ _tag: 'BrewingCommandResult', commandId: 'brew-1', accepted: false, revision: 4, reason: 'missing-ingredients' })
  })

  it('rejects an invalid result reason', () => {
    expect(decodeBrewingWireMessage(wire({
      _tag: 'BrewingCommandResult', commandId: 'brew-1', accepted: false, revision: 4, reason: 'server-error',
    }))).toBeUndefined()
    expect(decodeBrewingWireMessage(wire({
      _tag: 'BrewingCommandResult', commandId: '', accepted: true, revision: 4,
    }))).toBeUndefined()
    expect(decodeBrewingWireMessage(wire({
      _tag: 'BrewingCommandResult', commandId: 'brew-1', accepted: true, revision: -1,
    }))).toBeUndefined()
  })

  it('decodes brewing and player status deltas', () => {
    const standDelta = {
      _tag: 'BrewingStandDelta', world: 'world-1', revision: 5, at: command.at, state: emptyBrewingStandState(),
    } as const
    const statusDelta = {
      _tag: 'PlayerStatusEffectsDelta', world: 'world-1', revision: 5, player: 'alice', state: emptyStatusEffectState(),
    } as const

    expect(decodeBrewingWireMessage(wire(standDelta))).toEqual(standDelta)
    expect(decodeBrewingWireMessage(wire(statusDelta))).toEqual(statusDelta)
    expect(decodeBrewingWireMessage(wire({ ...standDelta, world: '' }))).toBeUndefined()
    expect(decodeBrewingWireMessage(wire({ ...standDelta, revision: -1 }))).toBeUndefined()
    expect(decodeBrewingWireMessage(wire({ ...standDelta, at: null }))).toBeUndefined()
    expect(decodeBrewingWireMessage(wire({ ...standDelta, state: null }))).toBeUndefined()
    expect(decodeBrewingWireMessage(wire({ ...statusDelta, world: '' }))).toBeUndefined()
    expect(decodeBrewingWireMessage(wire({ ...statusDelta, revision: -1 }))).toBeUndefined()
    expect(decodeBrewingWireMessage(wire({ ...statusDelta, player: '' }))).toBeUndefined()
    expect(decodeBrewingWireMessage(wire({ ...statusDelta, state: null }))).toBeUndefined()
  })
})
