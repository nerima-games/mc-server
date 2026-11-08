import { PlayerId, WorldId, type SurvivalActorState, type SurvivalSnapshot } from '@nerima-games/mx-multiplayer'
import { describe, expect, it } from 'vitest'

import {
  SleepAuthority,
  applySleepCommandResult,
  applySleepEvents,
  decodeSleepWireMessage,
  initialSleepClientState,
  queueSleepCommand,
  SLEEP_MAX_IDENTIFIER_LENGTH,
  SLEEP_MAX_WIRE_LENGTH,
  actorSleepLocation,
  sleepClientFromSnapshot,
  type SleepCommand,
} from '../apps/multiplayer-shared/sleep-network'

const alice = PlayerId.make('alice')
const bob = PlayerId.make('bob')
const bed = { x: 0, y: 64, z: 1 } as const
const actor = (player: typeof alice, session: string): SurvivalActorState => ({
  player,
  session,
  position: { x: 0, y: 64, z: 0 },
  gameMode: 'survival',
  inventory: [],
  health: 20,
  spawn: { x: 0, y: 64, z: 0 },
  lastActionTick: 0,
})
const snapshot = (...actors: ReadonlyArray<SurvivalActorState>): SurvivalSnapshot => ({
  world: WorldId.make('overworld'),
  revision: 0,
  actors,
  blocks: { '0,64,1': 'bed' },
  drops: [],
})
const command = (player: typeof alice, session: string, requestId: string, expectedRevision: number): SleepCommand => ({
  _tag: 'EnterSleep',
  actor: player,
  session,
  requestId,
  expectedRevision,
  clientTick: 5,
  bed,
})
const options = (sleepPercentage = 100) => ({
  sleepPercentage,
  validateSleep: () => ({ dimension: 'overworld', bedValid: true, nightOrThunder: true, safe: true }),
})

describe('authoritative sleep network adapter', () => {
  it('decodes complete authoritative sleep messages', () => {
    const message = { _tag: 'SleepSnapshot', snapshot: snapshot(actor(alice, 'a')) } as const
    expect(decodeSleepWireMessage(JSON.stringify(message))).toEqual(message)
  })

  it('decodes commands, results, every survival event, and populated snapshots', () => {
    const enter = command(alice, 'a', 'enter-1', 0)
    const leave = {
      _tag: 'LeaveSleep', actor: alice, session: 'a', requestId: 'leave-1', expectedRevision: 1, clientTick: 6,
    } as const
    for (const value of [enter, leave]) {
      const message = { _tag: 'SleepCommand', command: value } as const
      expect(decodeSleepWireMessage(JSON.stringify(message))).toEqual(message)
    }

    const sleeping = { dimension: 'overworld', bed }
    const events = [
      { _tag: 'InventoryChanged', actor: 'alice', slot: 0, stack: { item: 'bread', count: 1 } },
      { _tag: 'BlockChanged', at: bed, block: null },
      { _tag: 'BlockChanged', at: bed, block: 'stone' },
      { _tag: 'ActorDamaged', actor: 'alice', source: 'fall', health: 19 },
      { _tag: 'ActorDied', actor: 'alice', killer: 'wither' },
      { _tag: 'ItemDropped', item: 'bread', count: 1, at: bed },
      { _tag: 'ActorRespawned', actor: 'alice', at: bed, health: 20 },
      { _tag: 'ActorSleepChanged', actor: 'alice', sleeping },
      { _tag: 'SleepProgress', sleeping: 1, required: 2, connected: 2, ready: false },
      { _tag: 'NightSkipped', sleeping: 2, required: 2 },
    ] as const
    const result = { accepted: true, requestId: 'enter-1', revision: 1, events }
    const resultMessage = { _tag: 'SleepCommandResult', result } as const
    expect(decodeSleepWireMessage(JSON.stringify(resultMessage))).toEqual(resultMessage)
    const eventMessage = { _tag: 'SleepEvents', revision: 1, events } as const
    expect(decodeSleepWireMessage(JSON.stringify(eventMessage))).toEqual(eventMessage)

    const sleepingActor = {
      ...actor(alice, 'a'),
      inventory: [null, { item: 'bread', count: 2 }],
      sleeping,
    }
    const completeSnapshot = {
      ...snapshot(sleepingActor),
      drops: [{ item: 'bread', count: 1, at: bed }],
    }
    const snapshotMessage = { _tag: 'SleepSnapshot', snapshot: completeSnapshot } as const
    expect(decodeSleepWireMessage(JSON.stringify(snapshotMessage))).toEqual(snapshotMessage)
    const otherGameModes = { _tag: 'SleepSnapshot', snapshot: snapshot(
      { ...actor(alice, 'creative'), gameMode: 'creative' },
      { ...actor(bob, 'spectator'), gameMode: 'spectator' },
    ) } as const
    expect(decodeSleepWireMessage(JSON.stringify(otherGameModes))).toEqual(otherGameModes)

    const rejection = { accepted: false, requestId: 'duplicate-1', revision: 1, reason: 'duplicate-request' }
    const rejectionMessage = { _tag: 'SleepCommandResult', result: rejection } as const
    expect(decodeSleepWireMessage(JSON.stringify(rejectionMessage))).toEqual(rejectionMessage)
  })

  it('rejects malformed nested authoritative messages', () => {
    const malformedSnapshot = { _tag: 'SleepSnapshot', snapshot: { ...snapshot(actor(alice, 'a')), actors: [{ ...actor(alice, 'a'), health: 'full' }] } }
    const nonRecordActor = { _tag: 'SleepSnapshot', snapshot: { ...snapshot(actor(alice, 'a')), actors: [null] } }
    const malformedEvents = { _tag: 'SleepEvents', revision: 1, events: [{ _tag: 'ActorSleepChanged', actor: 'alice', sleeping: { dimension: 'overworld', bed: { x: 0, y: 'high', z: 1 } } }] }
    const nonRecordEvent = { _tag: 'SleepEvents', revision: 1, events: [null] }
    const invalidBlockEvent = { _tag: 'SleepEvents', revision: 1, events: [{ _tag: 'BlockChanged', at: bed, block: 7 }] }
    const malformedResult = { _tag: 'SleepCommandResult', result: { accepted: false, requestId: 'sleep-a', revision: 1, reason: 'unexpected' } }

    expect(decodeSleepWireMessage(JSON.stringify(malformedSnapshot))).toBeUndefined()
    expect(decodeSleepWireMessage(JSON.stringify(nonRecordActor))).toBeUndefined()
    expect(decodeSleepWireMessage(JSON.stringify(malformedEvents))).toBeUndefined()
    expect(decodeSleepWireMessage(JSON.stringify(nonRecordEvent))).toBeUndefined()
    expect(decodeSleepWireMessage(JSON.stringify(invalidBlockEvent))).toBeUndefined()
    expect(decodeSleepWireMessage(JSON.stringify(malformedResult))).toBeUndefined()
  })

  it.each([
    ['an inventory stack with no items', { _tag: 'SleepSnapshot', snapshot: { ...snapshot({ ...actor(alice, 'a'), inventory: [{ item: 'bread', count: 0 }] }) } }],
    ['a drop with no items', { _tag: 'SleepSnapshot', snapshot: { ...snapshot(actor(alice, 'a')), drops: [{ item: 'bread', count: 0, at: bed }] } }],
    ['an event with an unknown tag', { _tag: 'SleepEvents', revision: 1, events: [{ _tag: 'FutureSleepEvent' }] }],
    ['a command without a command record', { _tag: 'SleepCommand', command: null }],
    ['a command with an unknown tag', { _tag: 'SleepCommand', command: { ...command(alice, 'a', 'unknown', 0), _tag: 'WakeUp' } }],
  ])('rejects %s', (_case, message) => {
    expect(decodeSleepWireMessage(JSON.stringify(message))).toBeUndefined()
  })

  it.each([
    'duplicate-request',
    'stale-revision',
    'unauthorized-actor',
    'session-mismatch',
    'invalid-command',
    'invalid-game-mode',
    'out-of-reach',
    'insufficient-items',
    'cooldown-active',
    'occupied',
    'missing-block',
    'target-not-found',
    'target-dead',
    'actor-dead',
    'target-alive',
    'invalid-bed',
    'not-sleep-time',
    'sleep-unsafe',
    'already-sleeping',
    'not-sleeping',
  ])('preserves valid rejection reason %s', (reason) => {
    const message = {
      _tag: 'SleepCommandResult',
      result: { accepted: false, requestId: 'sleep-rejected', revision: 1, reason },
    }
    expect(decodeSleepWireMessage(JSON.stringify(message))).toEqual(message)
  })

  it('rejects non-object and malformed sleep frames', () => {
    expect(decodeSleepWireMessage('null')).toBeUndefined()
    expect(decodeSleepWireMessage('{"_tag":')).toBeUndefined()
    expect(decodeSleepWireMessage(JSON.stringify({ _tag: 'SleepCommand', command: { ...command(alice, 'a', 'bad-bed', 0), bed: { ...bed, y: 64.5 } } }))).toBeUndefined()
  })

  it('rejects oversized sleep wires and command identifiers', () => {
    const base = {
      _tag: 'SleepCommand',
      command: {
        _tag: 'EnterSleep', actor: 'alice', session: 'session-a', requestId: 'sleep-size',
        expectedRevision: 0, clientTick: 5, bed,
      },
    }
    for (const key of ['actor', 'session', 'requestId'] as const) {
      const wire = JSON.stringify({ ...base, command: { ...base.command, [key]: 'x'.repeat(SLEEP_MAX_IDENTIFIER_LENGTH + 1) } })
      expect(decodeSleepWireMessage(wire)).toBeUndefined()
    }
    const oversized = `${JSON.stringify(base)}${' '.repeat(SLEEP_MAX_WIRE_LENGTH)}`
    expect(oversized.length).toBeGreaterThan(SLEEP_MAX_WIRE_LENGTH)
    expect(decodeSleepWireMessage(oversized)).toBeUndefined()
  })

  it('does not apply local sleep until the server accepts it', () => {
    const pending = queueSleepCommand(initialSleepClientState(), command(alice, 'a', 'sleep-a', 0))
    expect(pending.sleepers.size).toBe(0)
    const authority = new SleepAuthority(snapshot(actor(alice, 'a')), options())
    const result = authority.execute(command(alice, 'a', 'sleep-a', 0))
    const applied = applySleepCommandResult(pending, result)
    expect(applied.sleepers.size).toBe(0)
    expect(applied.skippedRevision).toBe(1)
    expect(applied.pending.size).toBe(0)
  })

  it('uses ceil threshold for multiple actors and simultaneous revision ordering', () => {
    const authority = new SleepAuthority(snapshot(actor(alice, 'a'), actor(bob, 'b')), options(100))
    const first = authority.execute(command(alice, 'a', 'sleep-a', 0))
    expect(first).toMatchObject({ accepted: true, revision: 1 })
    if (!first.accepted) throw new Error('first sleep rejected')
    expect(first.events).toContainEqual({ _tag: 'SleepProgress', sleeping: 1, required: 2, connected: 2, ready: false })
    expect(authority.execute(command(bob, 'b', 'stale-b', 0))).toMatchObject({ accepted: false, reason: 'stale-revision' })
    const second = authority.execute(command(bob, 'b', 'sleep-b', 1))
    expect(second).toMatchObject({ accepted: true, revision: 2 })
    if (!second.accepted) throw new Error('second sleep rejected')
    expect(second.events.filter((event) => event._tag === 'NightSkipped')).toHaveLength(1)
  })

  it('rolls back rejected requests without changing authoritative sleepers', () => {
    const queued = queueSleepCommand(initialSleepClientState(), command(alice, 'wrong', 'rejected', 0))
    const result = new SleepAuthority(snapshot(actor(alice, 'a')), options()).execute(command(alice, 'wrong', 'rejected', 0))
    const applied = applySleepCommandResult(queued, result)
    expect(applied.sleepers.size).toBe(0)
    expect(applied.pending.size).toBe(0)
    expect(applied.rejection).toMatchObject({ accepted: false, reason: 'session-mismatch' })
  })

  it('applies duplicate night skip only once per revision', () => {
    const event = { _tag: 'NightSkipped', sleeping: 1, required: 1 } as const
    const once = applySleepEvents(initialSleepClientState(), 4, [event])
    const twice = applySleepEvents(once, 4, [event])
    expect(twice).toEqual(once)
  })

  it('removes sleepers on disconnect and restores snapshot state on rejoin', () => {
    const authority = new SleepAuthority(snapshot(actor(alice, 'a'), actor(bob, 'b')), options(100))
    authority.execute(command(alice, 'a', 'sleep-a', 0))
    expect(authority.disconnect(alice)).toContainEqual(expect.objectContaining({ _tag: 'ActorSleepChanged', actor: alice, sleeping: null }))

    const sleepingBob = { ...actor(bob, 'old'), sleeping: { dimension: 'overworld', bed } }
    const restoredAuthority = new SleepAuthority({ ...snapshot(sleepingBob), revision: 7 }, options())
    expect(restoredAuthority.rejoin(bob, 'old', 'new')).toBe(true)
    const restored = sleepClientFromSnapshot(restoredAuthority.snapshot())
    expect(restored.revision).toBe(7)
    expect(restored.sleepers.get(bob)).toEqual({ dimension: 'overworld', bed })
    expect(sleepClientFromSnapshot(snapshot(actor(alice, 'awake'))).sleepers.size).toBe(0)
  })

  it('keeps actor membership stable and rejects a repeated session request', () => {
    const authority = new SleepAuthority(snapshot(actor(alice, 'a')), options())
    expect(authority.addActor(actor(alice, 'replacement')).actors).toHaveLength(1)
    expect(authority.addActor(actor(bob, 'b')).actors.map((candidate) => candidate.player)).toEqual([alice, bob])

    const request = command(alice, 'a', 'sleep-once', 0)
    const accepted = authority.execute(request)
    expect(accepted.accepted).toBe(true)
    expect(authority.execute(request)).toEqual({
      accepted: false,
      requestId: 'sleep-once',
      revision: accepted.revision,
      reason: 'duplicate-request',
    })
  })

  it('applies sleeper changes and ignores events older than the client revision', () => {
    const sleeping = { dimension: 'overworld', bed }
    const started = applySleepEvents(initialSleepClientState(), 1, [
      { _tag: 'ActorSleepChanged', actor: alice, sleeping },
      { _tag: 'SleepProgress', sleeping: 1, required: 2, connected: 2, ready: false },
    ])
    expect(started.sleepers.get(alice)).toEqual(sleeping)
    expect(started.progress).toMatchObject({ _tag: 'SleepProgress', sleeping: 1 })

    const stopped = applySleepEvents(started, 2, [
      { _tag: 'ActorSleepChanged', actor: alice, sleeping: null },
    ])
    expect(stopped.sleepers.has(alice)).toBe(false)
    expect(applySleepEvents(stopped, 1, [{ _tag: 'NightSkipped', sleeping: 2, required: 2 }])).toBe(stopped)
  })

  it('exposes an actor sleep location without inventing one for awake actors', () => {
    expect(actorSleepLocation(actor(alice, 'awake'))).toBeUndefined()
    expect(actorSleepLocation({ ...actor(alice, 'sleeping'), sleeping: { dimension: 'overworld', bed } })).toEqual({
      dimension: 'overworld', bed,
    })
  })
})
