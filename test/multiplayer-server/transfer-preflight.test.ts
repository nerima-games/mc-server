import { once } from 'node:events'

import { decodeFrame, encodeFrame, NetherPortalUseCommand, PlayerId, PlayerName, ProtocolError, WorldId, type NetworkMessage } from '@nerima-games/mx-multiplayer'
import { Option, Result, Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

import type { MultiplayerServerCore, MultiplayerServerOptions } from '../../apps/multiplayer-server/core'
import { startMultiplayerServer, type MultiplayerRuntime } from '../../apps/multiplayer-server/main'
import { replicatedOwners } from './codec'

const capture = vi.hoisted(() => ({
  cores: new Map<string, MultiplayerServerCore>(),
  options: new Map<string, MultiplayerServerOptions>(),
  clientIds: new Map<string, string>(),
}))

vi.mock('../../apps/multiplayer-server/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/multiplayer-server/core')>()
  return {
    ...actual,
    makeMultiplayerServerCore: (options: MultiplayerServerOptions) => {
      const made = actual.makeMultiplayerServerCore(options)
      if (Result.isSuccess(made)) {
        const core = made.success
        capture.cores.set(options.worldId, core)
        capture.options.set(options.worldId, options)
        const connect = core.connect
        vi.spyOn(core, 'connect').mockImplementation((clientId, send) => {
          capture.clientIds.set(options.worldId, clientId)
          return connect(clientId, send)
        })
      }
      return made
    },
  }
})

const runtimes: Array<MultiplayerRuntime> = []
const sockets: Array<WebSocket> = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, 'close')
      socket.close()
      await closed
    }
  }
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()))
  vi.restoreAllMocks()
})

const nextMessage = (socket: WebSocket, tag: NetworkMessage['_tag']) => new Promise<NetworkMessage>((resolve) => {
  const receive = (data: WebSocket.RawData) => {
    const decoded = decodeFrame(data.toString(), replicatedOwners)
    if (Result.isSuccess(decoded) && decoded.success._tag === tag) {
      socket.off('message', receive)
      resolve(decoded.success)
    }
  }
  socket.on('message', receive)
})

describe('realm transfer snapshot preflight', () => {
  it('keeps the live connection and source player state when destination snapshot encoding fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const runtime = Result.getOrThrow(await startMultiplayerServer({
      host: '127.0.0.1', port: 0, worldId: 'transfer-source', seed: 73, installSignalHandlers: false,
    }))
    runtimes.push(runtime)
    const socket = new WebSocket(`ws://127.0.0.1:${String(runtime.port)}/ws`)
    sockets.push(socket)
    await once(socket, 'open')
    const authenticated = once(socket, 'message')
    socket.send(JSON.stringify({ _tag: 'PlayerResume', player: 'traveller' }))
    const [authentication] = await authenticated
    const authenticationMessage = JSON.parse(authentication.toString())
    expect(authenticationMessage._tag).toBe('PlayerResumeAccepted')
    expect(authenticationMessage.player).toBe('traveller')
    const initial = nextMessage(socket, 'AuthoritativeSnapshot')
    socket.send(Result.getOrThrow(encodeFrame({
      _tag: 'PlayerJoin', player: PlayerId.make('traveller'), name: PlayerName.make('Traveller'),
      at: { x: 0, y: 64, z: 0 },
    })))
    const before = await initial
    if (before._tag !== 'AuthoritativeSnapshot') return expect.unreachable('expected initial authority snapshot')
    const source = Option.getOrThrow(Option.fromUndefinedOr(capture.cores.get('transfer-source')))
    const destination = Option.getOrThrow(Option.fromUndefinedOr(capture.cores.get('nether')))
    const sourcePlayers = source.snapshot().players
    const detach = vi.spyOn(source, 'detachPlayer')
    const failure = {
      _tag: 'WorldWriteEncodingFailure',
      failure: new ProtocolError({ reason: 'unencodable-message', detail: 'transfer preflight fixture failure' }),
    } as const
    const prepare = vi.spyOn(destination, 'prepareRealmTransfer').mockReturnValueOnce(Result.fail(failure))
    const sourceOptions = Option.getOrThrow(Option.fromUndefinedOr(capture.options.get('transfer-source')))
    const transfer = Option.getOrThrow(Option.fromUndefinedOr(sourceOptions.onNetherPortalUse))
    const clientId = Option.getOrThrow(Option.fromUndefinedOr(capture.clientIds.get('transfer-source')))
    const command = Result.getOrThrow(Schema.decodeUnknownResult(NetherPortalUseCommand)({
      _tag: 'NetherPortalUseCommand', commandId: 'failed-transfer', expectedRevision: source.snapshot().revision,
      player: 'traveller', world: 'transfer-source', portal: { x: 0, y: 64, z: 0 },
    }))

    transfer(clientId, command)

    expect(prepare).toHaveBeenCalledOnce()
    expect(detach).not.toHaveBeenCalled()
    expect(source.snapshot().players).toStrictEqual(sourcePlayers)
    expect(destination.snapshot().players).toEqual([])
    expect(error).toHaveBeenCalledWith('Multiplayer realm transfer failed', expect.objectContaining({ failure }))
    const resync = nextMessage(socket, 'AuthoritativeSnapshot')
    socket.send(Result.getOrThrow(encodeFrame({
      _tag: 'AuthoritativeResyncRequest', world: WorldId.make('transfer-source'),
    })))
    const after = await resync
    if (after._tag !== 'AuthoritativeSnapshot') return expect.unreachable('expected source resync snapshot')
    expect(after.world).toBe('transfer-source')
    expect(after.inventories).toStrictEqual(before.inventories)
    expect(after.vitals).toStrictEqual(before.vitals)
  })
})
