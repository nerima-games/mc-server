import { once } from 'node:events'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { encodeFrame, PlayerId, PlayerName } from '@nerima-games/mx-multiplayer'
import { Effect, Result } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

import { startMultiplayerServer, type MultiplayerRuntime } from '../../apps/multiplayer-server/main'

const probe = vi.hoisted(() => {
  let enter!: () => void
  let release!: () => void
  return {
    file: '', before: '', attempts: 0, ticks: 0,
    failure: new Error('injected persistence disk failure'),
    tickEntered: new Promise<void>((resolve) => { enter = resolve }),
    tickRelease: new Promise<void>((resolve) => { release = resolve }),
    enter: () => enter(), release: () => release(),
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const [path, data] = args
      if (typeof path === 'string' && path.startsWith(`${probe.file}.${String(process.pid)}.`)
        && path.endsWith('.tmp') && typeof data === 'string' && data.includes('"player":"save-failure-player"')) {
        probe.before = await actual.readFile(probe.file, 'utf8')
        probe.attempts += 1
        throw probe.failure
      }
      return actual.writeFile(...args)
    },
  }
})
vi.mock('../../apps/multiplayer-server/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/multiplayer-server/core')>()
  return {
    ...actual,
    makeMultiplayerServerCore: (...args: Parameters<typeof actual.makeMultiplayerServerCore>) => {
      const result = actual.makeMultiplayerServerCore(...args)
      if (Result.isSuccess(result)) {
        const tick = result.success.tick
        vi.spyOn(result.success, 'tick').mockImplementation((elapsedMs) => {
          probe.ticks += 1
          return tick(elapsedMs)
        })
      }
      return result
    },
  }
})
vi.mock('../../apps/multiplayer-server/redstone-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/multiplayer-server/redstone-runtime')>()
  return {
    ...actual,
    makeMultiplayerRedstoneRuntime: async (...args: Parameters<typeof actual.makeMultiplayerRedstoneRuntime>) => {
      const runtime = await actual.makeMultiplayerRedstoneRuntime(...args)
      return {
        tick: (elapsedMs: number) => Effect.andThen(Effect.promise(async () => {
          probe.enter()
          await probe.tickRelease
        }), runtime.tick(elapsedMs)),
      }
    },
  }
})

let runtime: MultiplayerRuntime | undefined
let socket: WebSocket | undefined
afterEach(async () => {
  probe.release()
  if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) socket.terminate()
  if (runtime !== undefined) {
    try { await runtime.close() } catch (failure) { expect(failure).toBe(probe.failure) }
  }
  vi.restoreAllMocks()
})

describe('fatal multiplayer state persistence', () => {
  it('logs the original disk failure immediately, stops the live server and does not resume an in-flight tick', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    probe.file = join(await mkdtemp(join(tmpdir(), 'server-fatal-save-')), 'state.json')
    await writeFile(probe.file, JSON.stringify({ format: 1, worldId: 'save-failure', seed: 73, state: {
      revision: 0, blocks: [], inventories: [], vitals: [],
      timeWeather: { timeOfDay: 6000, weather: 'clear' }, containers: [], furnaces: [], villagerTrades: [],
    } }), 'utf8')
    runtime = Result.getOrThrow(await startMultiplayerServer({
      host: '127.0.0.1', port: 0, worldId: 'save-failure', seed: 73, stateFile: probe.file, installSignalHandlers: false,
    }))
    const port = runtime.port
    socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`)
    await once(socket, 'open')
    const authentication = once(socket, 'message')
    socket.send(JSON.stringify({ _tag: 'PlayerResume', player: 'save-failure-player' }))
    const [authenticationData] = await authentication
    const authenticationMessage: unknown = JSON.parse(authenticationData.toString())
    if (authenticationMessage === null || typeof authenticationMessage !== 'object'
      || !('_tag' in authenticationMessage) || !('player' in authenticationMessage)) {
      return expect.unreachable('expected authentication reply')
    }
    expect(authenticationMessage._tag).toBe('PlayerResumeAccepted')
    expect(authenticationMessage.player).toBe('save-failure-player')
    await probe.tickEntered
    const closed = once(socket, 'close')
    socket.send(Result.getOrThrow(encodeFrame({
      _tag: 'PlayerJoin', player: PlayerId.make('save-failure-player'), name: PlayerName.make('Save failure'),
      at: { x: 0, y: 64, z: 0 },
    })))
    const [code] = await closed
    expect(code).toBe(1001)
    expect(logged).toHaveBeenCalledExactlyOnceWith('Multiplayer state persistence failed', { failure: probe.failure })
    expect(probe.attempts).toBe(1)
    expect(await readFile(probe.file, 'utf8')).toBe(probe.before)
    expect(probe.before).not.toContain('"player":"save-failure-player"')
    await expect(fetch(`http://127.0.0.1:${String(port)}/health`)).rejects.toThrow()
    probe.release()
    await expect(runtime.close()).rejects.toBe(probe.failure)
    expect(probe.ticks).toBe(0)
    expect(probe.attempts).toBe(1)
    expect(await readFile(probe.file, 'utf8')).toBe(probe.before)
  })
})
