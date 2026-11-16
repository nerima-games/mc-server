import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { encodeFrame, EntityId, PlayerId, PlayerName } from '@nerima-games/mx-multiplayer'
import { Effect, Option, Result } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

import { startMultiplayerServer, type MultiplayerRuntime } from '../../apps/multiplayer-server/main'

const probe = vi.hoisted(() => {
  const signal = () => {
    let resolve!: () => void
    return { reached: new Promise<void>((done) => { resolve = done }), reach: () => resolve() }
  }
  const tickGate = () => ({ entered: signal(), released: signal() })
  const state = {
    file: '', baseFile: '', before: '', attemptedData: '', attempts: 0, armed: false,
    failure: new Error('injected persistence disk failure'),
    tick: tickGate(),
    joined: signal(),
    cores: new Map<string, import('../../apps/multiplayer-server/core').MultiplayerServerCore>(),
    ticks: new Map<string, number>(),
    pendingWrites: new Set<Promise<unknown>>(),
    ioFailures: new Array<unknown>(),
    track<A>(operation: Promise<A>): Promise<A> {
      this.pendingWrites.add(operation)
      void operation.then(
        () => this.pendingWrites.delete(operation),
        (failure: unknown) => { this.ioFailures.push(failure); this.pendingWrites.delete(operation) },
      )
      return operation
    },
    files: new Array<{ path: string; world: string; healthyMarker: string; commits: number; committed: ReturnType<typeof signal> }>(),
    reset() {
      this.file = ''
      this.baseFile = ''
      this.before = ''
      this.attemptedData = ''
      this.attempts = 0
      this.armed = false
      this.failure = new Error('injected persistence disk failure')
      this.tick = tickGate()
      this.joined = signal()
      this.cores.clear()
      this.ticks.clear()
      this.ioFailures = []
      this.files = []
    },
    addFile(path: string, world: string) {
      const file = { path, world, healthyMarker: `${world}-healthy-drop`, commits: 0, committed: signal() }
      this.files.push(file)
      return file
    },
  }
  return state
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdir: (...args: Parameters<typeof actual.mkdir>) => probe.track(actual.mkdir(...args)),
    writeFile: (...args: Parameters<typeof actual.writeFile>) => probe.track((async () => {
      const [path, data] = args
      const prefix = `${probe.file}.${String(process.pid)}.`
      if (probe.armed && typeof path === 'string' && path.startsWith(prefix)
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(path.slice(prefix.length))
        && typeof data === 'string') {
        probe.before = await actual.readFile(probe.file, 'utf8')
        probe.attemptedData = data
        probe.attempts += 1
        throw probe.failure
      }
      return actual.writeFile(...args)
    })()),
    rename: (...args: Parameters<typeof actual.rename>) => probe.track((async () => {
      await actual.rename(...args)
      const destination = args[1]
      const file = probe.files.find((file) => file.path === destination)
      if (file === undefined) return
      file.commits += 1
      const saved = await actual.readFile(file.path, 'utf8')
      if (file.path === probe.baseFile && saved.includes('"player":"save-failure-player"')) probe.joined.reach()
      if (saved.includes(file.healthyMarker)) file.committed.reach()
    })()),
  }
})
vi.mock('../../apps/multiplayer-server/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/multiplayer-server/core')>()
  return {
    ...actual,
    makeMultiplayerServerCore: (...args: Parameters<typeof actual.makeMultiplayerServerCore>) => {
      const result = actual.makeMultiplayerServerCore(...args)
      if (Result.isSuccess(result)) {
        const world = args[0].worldId
        probe.cores.set(world, result.success)
        probe.ticks.set(world, 0)
        const tick = result.success.tick
        vi.spyOn(result.success, 'tick').mockImplementation((elapsedMs) => {
          probe.ticks.set(world, Number(probe.ticks.get(world)) + 1)
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
          probe.tick.entered.reach()
          await probe.tick.released.reached
        }), runtime.tick(elapsedMs)),
      }
    },
  }
})

let runtime: MultiplayerRuntime | undefined
let socket: WebSocket | undefined
let directory: string | undefined
let previousExitCode: typeof process.exitCode
beforeEach(() => {
  expect(probe.pendingWrites.size).toBe(0)
  probe.reset()
  runtime = undefined
  socket = undefined
  directory = undefined
  previousExitCode = process.exitCode
  process.exitCode = undefined
})
afterEach(async () => {
  try {
    const closing = runtime?.close()
    probe.tick.released.reach()
    if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) socket.terminate()
    if (closing !== undefined) {
      try { await closing } catch (failure) { expect(failure).toBe(probe.failure) }
    }
    // A rejected realm drain can finish before sibling drains; wait for their actual write/rename chains.
    do {
      await Promise.allSettled([...probe.pendingWrites])
      await new Promise<void>((resolve) => setImmediate(resolve))
    } while (probe.pendingWrites.size > 0)
    for (const failure of probe.ioFailures) expect(failure).toBe(probe.failure)
    if (directory !== undefined) await rm(directory, { recursive: true })
  } finally {
    process.exitCode = previousExitCode
    vi.restoreAllMocks()
  }
})

describe('fatal multiplayer state persistence', () => {
  for (const failingRealm of ['overworld', 'nether', 'end']) {
    it(`stops all realms after only ${failingRealm} persistence fails`, async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      let websocketClosed!: () => void
      const websocketServerClosed = new Promise<void>((resolve) => { websocketClosed = resolve })
      const closeWebSocketServer = WebSocketServer.prototype.close
      const websocketClose = vi.spyOn(WebSocketServer.prototype, 'close').mockImplementation(function (this: WebSocketServer, callback) {
        this.once('close', websocketClosed)
        closeWebSocketServer.call(this, callback)
      })
      directory = await mkdtemp(join(tmpdir(), 'server-fatal-save-'))
      probe.baseFile = join(directory, 'state.json')
      const files = [
        probe.addFile(probe.baseFile, 'save-failure'),
        probe.addFile(`${probe.baseFile}.nether`, 'nether'),
        probe.addFile(`${probe.baseFile}.end`, 'end'),
      ]
      for (const file of files) {
        await writeFile(file.path, JSON.stringify({ format: 1, worldId: file.world, seed: 73, state: {
          revision: 0, blocks: [], inventories: [], vitals: [],
          timeWeather: { timeOfDay: 6000, weather: 'clear' }, containers: [], furnaces: [], villagerTrades: [],
        } }), 'utf8')
      }
      runtime = Result.getOrThrow(await startMultiplayerServer({
        host: '127.0.0.1', port: 0, worldId: 'save-failure', seed: 73,
        stateFile: probe.baseFile, installSignalHandlers: true,
      }))
      expect(probe.cores.size).toBe(3)
      const port = runtime.port
      socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`)
      await once(socket, 'open')
      const authentication = once(socket, 'message')
      socket.send(JSON.stringify({ _tag: 'PlayerResume', player: 'save-failure-player' }))
      const [authenticationData] = await authentication
      const authenticationMessage: unknown = JSON.parse(authenticationData.toString())
      expect(authenticationMessage).toMatchObject({ _tag: 'PlayerResumeAccepted', player: 'save-failure-player' })
      await probe.tick.entered.reached
      socket.send(Result.getOrThrow(encodeFrame({
        _tag: 'PlayerJoin', player: PlayerId.make('save-failure-player'), name: PlayerName.make('Save failure'),
        at: { x: 0, y: 64, z: 0 },
      })))
      await probe.joined.reached
      const failingWorld = failingRealm === 'overworld' ? 'save-failure' : failingRealm
      const target = Option.getOrThrow(Option.fromUndefinedOr(files.find((file) => file.world === failingWorld)))
      const healthy = files.filter((file) => file !== target)
      const spawn = (world: string, marker: string) => Result.getOrThrow(
        Option.getOrThrow(Option.fromUndefinedOr(probe.cores.get(world))).spawnEntity({
          _tag: 'item-drop', entityId: EntityId.make(marker), at: { x: 0, y: 64, z: 0 }, stack: { item: 'stone', count: 1 },
        }),
      )
      for (const file of healthy) spawn(file.world, file.healthyMarker)
      await Promise.all(healthy.map((file) => file.committed.reached))
      expect(logged).not.toHaveBeenCalled()
      expect(process.exitCode).toBeUndefined()
      probe.file = target.path
      probe.armed = true
      const closed = once(socket, 'close')
      const marker = `${target.world}-fatal-drop`
      spawn(target.world, marker)
      await expect.poll(() => logged.mock.calls).toEqual([['Multiplayer state persistence failed', { failure: probe.failure }]])
      expect(process.exitCode).toBe(1)
      const [code] = await closed
      expect(code).toBe(1001)
      await websocketServerClosed
      expect(websocketClose).toHaveBeenCalledOnce()
      expect(probe.attempts).toBe(1)
      const attempted: unknown = JSON.parse(probe.attemptedData)
      expect(attempted).toMatchObject({ worldId: target.world, state: { entities: [expect.objectContaining({ entityId: marker })] } })
      expect(probe.before).not.toContain(marker)
      expect(await readFile(target.path, 'utf8')).toBe(probe.before)
      for (const file of healthy) {
        expect(file.commits).toBeGreaterThan(0)
        expect(await readFile(file.path, 'utf8')).toContain(file.healthyMarker)
      }
      await expect(fetch(`http://127.0.0.1:${String(port)}/health`)).rejects.toThrow()
      const refused = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`)
      const refusedError = once(refused, 'error')
      const refusedClosed = new Promise<void>((resolve) => { refused.once('close', () => resolve()) })
      expect((await refusedError)[0]).toMatchObject({ code: 'ECONNREFUSED' })
      await refusedClosed
      probe.tick.released.reach()
      await expect(runtime.close()).rejects.toBe(probe.failure)
      expect(probe.ticks).toEqual(new Map([['save-failure', 0], ['nether', 0], ['end', 0]]))
      expect(logged).toHaveBeenCalledExactlyOnceWith('Multiplayer state persistence failed', { failure: probe.failure })
      expect(probe.attempts).toBe(1)
      expect(process.exitCode).toBe(1)
      expect(await readFile(target.path, 'utf8')).toBe(probe.before)
    })
  }
})
