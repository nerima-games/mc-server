import { describe, expect, it } from 'vitest'

import type { WireText } from '@nerima-games/mx-multiplayer'

import { decodeWitherWireMessage, WITHER_MAX_WIRE_LENGTH } from '../apps/multiplayer-shared/wither-network'

const wire = (message: unknown): WireText => JSON.stringify(message) as WireText

const snapshot = {
  nextWitherId: 2,
  nextSkullId: 1,
  withers: [{
    id: 'wither-1',
    dimension: 'overworld',
    snapshot: {
      kind: 'wither',
      version: 1,
      state: {
        phase: 'airborne',
        healthPoints: 300,
        chargeRemainingSecs: 0,
        feetPosition: { x: 1, y: 64, z: 1 },
        velocity: { x: 0, y: 0, z: 0 },
      },
    },
    rangedCooldownSecs: 2,
    meleeCooldownSecs: 0,
    shotsFired: 3,
  }],
  skulls: [{
    id: 'wither-skull-1',
    ownerId: 'wither-1',
    dimension: 'overworld',
    descriptor: {
      kind: 'wither_skull',
      variant: 'blue',
      origin: { x: 1, y: 66, z: 1 },
      direction: { x: 0, y: 0, z: 1 },
      speed: 1,
      explosivePower: 1,
      destroysResistantBlocks: true,
    },
    position: { x: 1, y: 66, z: 1 },
    ageSecs: 0,
  }],
}

describe('decodeWitherWireMessage', () => {
  it('reconstructs every supported command without trusting parsed JSON', () => {
    expect(decodeWitherWireMessage(wire({
      _tag: 'WitherCommand',
      command: {
        _tag: 'SummonWither', actor: 'alice', requestId: 'summon-1', expectedRevision: 0,
        dimension: 'overworld', position: { x: 1, y: 64, z: 1 },
      },
    }))).toEqual({
      _tag: 'WitherCommand',
      command: {
        _tag: 'SummonWither', actor: 'alice', requestId: 'summon-1', expectedRevision: 0,
        dimension: 'overworld', position: { x: 1, y: 64, z: 1 },
      },
    })

    for (const kind of ['magic', 'void'] as const) {
      expect(decodeWitherWireMessage(wire({
        _tag: 'WitherCommand',
        command: {
          _tag: 'DamageWither', actor: 'alice', requestId: `damage-${kind}`, expectedRevision: 1,
          id: 'wither-1', amount: 4, kind,
        },
      }))).toMatchObject({ _tag: 'WitherCommand', command: { _tag: 'DamageWither', kind } })
    }
  })

  it('requires result consistency and complete runtime snapshots', () => {
    expect(decodeWitherWireMessage(wire({
      _tag: 'WitherCommandResult', requestId: 'summon-1', accepted: false, revision: 1,
      reason: 'stale-revision',
    }))).toEqual({
      _tag: 'WitherCommandResult', requestId: 'summon-1', accepted: false, revision: 1,
      reason: 'stale-revision',
    })
    expect(decodeWitherWireMessage(wire({
      _tag: 'WitherCommandResult', requestId: 'summon-1', accepted: false, revision: 1,
    }))).toBeUndefined()
    expect(decodeWitherWireMessage(wire({ _tag: 'WitherSnapshot', revision: 2, snapshot }))).toMatchObject({
      _tag: 'WitherSnapshot', revision: 2, snapshot,
    })
    expect(decodeWitherWireMessage(wire({
      _tag: 'WitherSnapshot',
      revision: 2,
      snapshot: { ...snapshot, withers: [{ ...snapshot.withers[0], snapshot: { kind: 'wither', version: 1 } }] },
    }))).toBeUndefined()
    expect(decodeWitherWireMessage(wire({
      _tag: 'WitherCommandResult', requestId: 'summon-2', accepted: true, revision: 2,
    }))).toEqual({ _tag: 'WitherCommandResult', requestId: 'summon-2', accepted: true, revision: 2 })
    expect(decodeWitherWireMessage(wire({
      _tag: 'WitherCommandResult', requestId: 'summon-3', accepted: false, revision: 2, reason: 'invalid-command',
    }))).toEqual({
      _tag: 'WitherCommandResult', requestId: 'summon-3', accepted: false, revision: 2, reason: 'invalid-command',
    })
  })

  it('rejects extra fields and oversized messages at the protocol boundary', () => {
    expect(decodeWitherWireMessage(wire({
      _tag: 'WitherCommand',
      command: {
        _tag: 'SummonWither', actor: 'alice', requestId: 'summon-1', expectedRevision: 0,
        dimension: 'overworld', position: { x: 1, y: 64, z: 1 }, extra: true,
      },
    }))).toBeUndefined()
    expect(decodeWitherWireMessage('x'.repeat(WITHER_MAX_WIRE_LENGTH + 1) as WireText)).toBeUndefined()
    expect(decodeWitherWireMessage('null' as WireText)).toBeUndefined()
    expect(decodeWitherWireMessage('{"_tag":' as WireText)).toBeUndefined()
    expect(decodeWitherWireMessage(wire({ _tag: 'WitherCommand', command: null }))).toBeUndefined()
    expect(decodeWitherWireMessage(wire({
      _tag: 'WitherCommandResult', requestId: 'summon-4', accepted: false, revision: 2, reason: 'server-error',
    }))).toBeUndefined()
  })

  it('rejects invalid command fields and non-exact command envelopes', () => {
    const summon = {
      _tag: 'SummonWither', actor: 'alice', requestId: 'summon-1', expectedRevision: 0,
      dimension: 'overworld', position: { x: 1, y: 64, z: 1 },
    }
    const damage = {
      _tag: 'DamageWither', actor: 'alice', requestId: 'damage-1', expectedRevision: 0,
      id: 'wither-1', amount: 4, kind: 'melee',
    }
    for (const invalid of [
      { ...summon, actor: '' },
      { ...summon, expectedRevision: -1 },
      { ...summon, dimension: '' },
      { ...summon, position: null },
      { ...damage, id: '' },
      { ...damage, amount: -1 },
      { ...damage, kind: 'fall' },
    ]) {
      expect(decodeWitherWireMessage(wire({ _tag: 'WitherCommand', command: invalid }))).toBeUndefined()
    }

    expect(decodeWitherWireMessage(wire({ _tag: 'WitherCommand', command: summon, extra: true }))).toBeUndefined()
    expect(decodeWitherWireMessage(wire({ _tag: 'WitherCommandResult', requestId: '', accepted: true, revision: 1 }))).toBeUndefined()
    expect(decodeWitherWireMessage(wire({ _tag: 'WitherCommandResult', requestId: 'summon-5', accepted: true, revision: -1 }))).toBeUndefined()
  })

  it.each([
    ['a null runtime snapshot', null],
    ['a runtime snapshot with an unknown field', { ...snapshot, extra: true }],
    ['a negative runtime id', { ...snapshot, nextWitherId: -1 }],
    ['a non-record wither entry', { ...snapshot, withers: [null] }],
    ['an unsupported wither phase', {
      ...snapshot,
      withers: [{ ...snapshot.withers[0]!, snapshot: { ...snapshot.withers[0]!.snapshot, state: { ...snapshot.withers[0]!.snapshot.state, phase: 'hovering' } } }],
    }],
    ['a non-finite wither position', {
      ...snapshot,
      withers: [{ ...snapshot.withers[0]!, snapshot: { ...snapshot.withers[0]!.snapshot, state: { ...snapshot.withers[0]!.snapshot.state, feetPosition: { x: Number.NaN, y: 64, z: 1 } } } }],
    }],
    ['a missing wither position record', {
      ...snapshot,
      withers: [{ ...snapshot.withers[0]!, snapshot: { ...snapshot.withers[0]!.snapshot, state: { ...snapshot.withers[0]!.snapshot.state, feetPosition: null } } }],
    }],
    ['a non-record skull descriptor', { ...snapshot, skulls: [{ ...snapshot.skulls[0]!, descriptor: null }] }],
    ['a skull descriptor with an unsupported kind', {
      ...snapshot,
      skulls: [{ ...snapshot.skulls[0]!, descriptor: { ...snapshot.skulls[0]!.descriptor, kind: 'wither_bolt' } }],
    }],
    ['an unsupported skull variant', {
      ...snapshot,
      skulls: [{ ...snapshot.skulls[0]!, descriptor: { ...snapshot.skulls[0]!.descriptor, variant: 'green' } }],
    }],
    ['a non-record skull entry', { ...snapshot, skulls: [null] }],
    ['a negative skull age', { ...snapshot, skulls: [{ ...snapshot.skulls[0]!, ageSecs: -1 }] }],
    ['a non-array skull collection', { ...snapshot, skulls: null }],
  ])('rejects snapshots containing %s', (_case, invalidSnapshot) => {
    expect(decodeWitherWireMessage(wire({ _tag: 'WitherSnapshot', revision: 2, snapshot: invalidSnapshot }))).toBeUndefined()
  })
})
