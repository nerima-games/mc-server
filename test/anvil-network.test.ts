import type { WireText } from '@nerima-games/mx-multiplayer'
import { describe, expect, it } from 'vitest'

import { ANVIL_MAX_WIRE_LENGTH, decodeAnvilWireMessage } from '../apps/multiplayer-shared/anvil-network'

const wire = (value: unknown): WireText => JSON.stringify(value) as WireText

const command = {
  _tag: 'AnvilCommand',
  commandId: 'anvil-1',
  player: 'alice',
  world: 'world-1',
  expectedRevision: 4,
  slot: 5,
  name: 'Hunter',
} as const

describe('anvil wire codec', () => {
  it('decodes a valid command', () => {
    expect(decodeAnvilWireMessage(wire(command))).toEqual(command)
  })

  it('rejects malformed JSON, non-object payloads, and oversized frames', () => {
    expect(decodeAnvilWireMessage('not-json' as WireText)).toBeUndefined()
    expect(decodeAnvilWireMessage(wire(null))).toBeUndefined()
    expect(decodeAnvilWireMessage('x'.repeat(ANVIL_MAX_WIRE_LENGTH + 1) as WireText)).toBeUndefined()
  })

  it.each([
    ['invalid slot', { ...command, slot: 36 }],
    ['control character in name', { ...command, name: 'Hunter\n' }],
    ['oversized name', { ...command, name: 'x'.repeat(51) }],
    ['extra command field', { ...command, extra: true }],
  ])('rejects %s', (_case, message) => {
    expect(decodeAnvilWireMessage(wire(message))).toBeUndefined()
  })

  it('decodes private name deltas and rejects duplicate slots', () => {
    expect(decodeAnvilWireMessage(wire({
      _tag: 'PlayerAnvilNamesDelta', world: 'world-1', revision: 5, player: 'alice', names: [{ slot: 5, name: 'Hunter' }],
    }))).toEqual({
      _tag: 'PlayerAnvilNamesDelta', world: 'world-1', revision: 5, player: 'alice', names: [{ slot: 5, name: 'Hunter' }],
    })
    expect(decodeAnvilWireMessage(wire({
      _tag: 'PlayerAnvilNamesDelta', world: 'world-1', revision: 5, player: 'alice', names: [{ slot: 5, name: 'Hunter' }, { slot: 5, name: 'Bow' }],
    }))).toBeUndefined()
    expect(decodeAnvilWireMessage(wire({
      _tag: 'PlayerAnvilNamesDelta', world: 'world-1', revision: 5, player: 'alice', names: null,
    }))).toBeUndefined()
    expect(decodeAnvilWireMessage(wire({
      _tag: 'PlayerAnvilNamesDelta', world: 'world-1', revision: 5, player: 'alice', names: [{ slot: 5, name: '' }],
    }))).toBeUndefined()
  })

  it('decodes rejected command results and rejects unknown reasons', () => {
    expect(decodeAnvilWireMessage(wire({
      _tag: 'AnvilCommandResult', commandId: 'anvil-1', accepted: true, revision: 5,
    }))).toEqual({ _tag: 'AnvilCommandResult', commandId: 'anvil-1', accepted: true, revision: 5 })

    const reasons = [
      'stale-revision',
      'unauthorized-player',
      'wrong-world',
      'invalid-command',
      'no-item',
      'no-change',
      'missing-iron',
      'insufficient-experience',
    ] as const

    for (const reason of reasons) {
      expect(decodeAnvilWireMessage(wire({
        _tag: 'AnvilCommandResult', commandId: 'anvil-1', accepted: false, revision: 4, reason,
      }))).toEqual({ _tag: 'AnvilCommandResult', commandId: 'anvil-1', accepted: false, revision: 4, reason })
    }
    expect(decodeAnvilWireMessage(wire({
      _tag: 'AnvilCommandResult', commandId: 'anvil-1', accepted: false, revision: 4, reason: 'server-error',
    }))).toBeUndefined()
    expect(decodeAnvilWireMessage(wire({
      _tag: 'AnvilCommandResult', commandId: 'anvil-1', accepted: false, revision: 4, reason: 'no-item', extra: true,
    }))).toBeUndefined()
    expect(decodeAnvilWireMessage(wire({
      _tag: 'AnvilCommandResult', commandId: '', accepted: false, revision: 4, reason: 'no-item',
    }))).toBeUndefined()
  })
})
