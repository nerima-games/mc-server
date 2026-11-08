import type { WireText } from '@nerima-games/mx-multiplayer'
import { describe, expect, it } from 'vitest'

import {
  decodeEnderDragonWireMessage,
  ENDER_DRAGON_MAX_WIRE_LENGTH,
  encodeEnderDragonCommand,
} from '../apps/multiplayer-shared/ender-dragon-network'

describe('Ender Dragon wire protocol', () => {
  it('encodes and strictly decodes a server-owned damage command', () => {
    const command = {
      _tag: 'DamageEnderDragon' as const,
      actor: 'alice',
      requestId: 'dragon-1',
      expectedRevision: 3,
    }

    expect(decodeEnderDragonWireMessage(encodeEnderDragonCommand(command))).toEqual({
      _tag: 'EnderDragonCommand',
      command,
    })
  })

  it('decodes only valid snapshots and discriminated command results', () => {
    expect(decodeEnderDragonWireMessage(JSON.stringify({
      _tag: 'EnderDragonSnapshot',
      revision: 4,
      snapshot: { phase: 'circling', phaseTimerSecs: 0, health: 200, rewardEmitted: false },
    }) as WireText)).toEqual(expect.objectContaining({ _tag: 'EnderDragonSnapshot', revision: 4 }))
    expect(decodeEnderDragonWireMessage(JSON.stringify({
      _tag: 'EnderDragonCommandResult', requestId: 'dragon-1', accepted: false, revision: 4, reason: 'stale-revision',
    }) as WireText)).toEqual({
      _tag: 'EnderDragonCommandResult', requestId: 'dragon-1', accepted: false, revision: 4, reason: 'stale-revision',
    })
    expect(decodeEnderDragonWireMessage(JSON.stringify({
      _tag: 'EnderDragonCommandResult', requestId: 'dragon-2', accepted: true, revision: 5,
    }) as WireText)).toEqual({
      _tag: 'EnderDragonCommandResult', requestId: 'dragon-2', accepted: true, revision: 5,
    })
    expect(decodeEnderDragonWireMessage(JSON.stringify({
      _tag: 'EnderDragonCommandResult', requestId: 'dragon-3', accepted: false, revision: 5, reason: 'invalid-command',
    }) as WireText)).toEqual({
      _tag: 'EnderDragonCommandResult', requestId: 'dragon-3', accepted: false, revision: 5, reason: 'invalid-command',
    })
  })

  it('rejects forged fields, invalid snapshots, and oversized frames', () => {
    expect(decodeEnderDragonWireMessage(JSON.stringify({
      _tag: 'EnderDragonCommand',
      command: { _tag: 'DamageEnderDragon', actor: 'alice', requestId: 'dragon-1', expectedRevision: 0, amount: 200 },
    }) as WireText)).toBeUndefined()
    expect(decodeEnderDragonWireMessage(JSON.stringify({
      _tag: 'EnderDragonSnapshot',
      revision: 0,
      snapshot: { phase: 'dead', phaseTimerSecs: 0, health: 1, rewardEmitted: true },
    }) as WireText)).toBeUndefined()
    expect(decodeEnderDragonWireMessage(JSON.stringify(null) as WireText)).toBeUndefined()
    expect(decodeEnderDragonWireMessage('{"_tag":' as WireText)).toBeUndefined()
    expect(decodeEnderDragonWireMessage(JSON.stringify({
      _tag: 'EnderDragonCommandResult', requestId: 'dragon-4', accepted: false, revision: 5, reason: 'server-error',
    }) as WireText)).toBeUndefined()
    expect(decodeEnderDragonWireMessage('x'.repeat(ENDER_DRAGON_MAX_WIRE_LENGTH + 1) as WireText)).toBeUndefined()
  })
})
