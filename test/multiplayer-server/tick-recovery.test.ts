import { Effect, Result } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { startMultiplayerServer, type MultiplayerRuntime } from '../../apps/multiplayer-server/main'

const probe = vi.hoisted(() => {
  let resolve!: () => void
  const resumed = new Promise<void>((finish) => { resolve = finish })
  return { attempts: 0, failure: new Error('tick fixture defect'), resumed, resolve }
})

vi.mock('../../apps/multiplayer-server/redstone-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/multiplayer-server/redstone-runtime')>()
  return {
    ...actual,
    makeMultiplayerRedstoneRuntime: async (...args: Parameters<typeof actual.makeMultiplayerRedstoneRuntime>) => {
      const runtime = await actual.makeMultiplayerRedstoneRuntime(...args)
      return {
        tick: (elapsedMs: number) => {
          probe.attempts += 1
          if (probe.attempts === 1) return Effect.die(probe.failure)
          return Effect.tap(runtime.tick(elapsedMs), (result) =>
            Effect.sync(() => { if (Result.isSuccess(result)) probe.resolve() }))
        },
      }
    },
  }
})

const runtimes: Array<MultiplayerRuntime> = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()))
  vi.restoreAllMocks()
})

describe('multiplayer server tick recovery', () => {
  it('records a real tick defect and executes the following tick through the live timer chain', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const runtime = Result.getOrThrow(await startMultiplayerServer({
      host: '127.0.0.1', port: 0, worldId: 'tick-recovery', seed: 73, installSignalHandlers: false,
    }))
    runtimes.push(runtime)

    await probe.resumed

    expect(probe.attempts).toBeGreaterThanOrEqual(2)
    expect(error).toHaveBeenCalledWith('Multiplayer server tick failed', {
      failure: expect.anything(),
    })
    expect(error.mock.calls.filter(([message]) => message === 'Multiplayer server tick failed')).toHaveLength(1)
    const response = await fetch(`http://127.0.0.1:${String(runtime.port)}/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toStrictEqual({ status: 'ok', world: 'tick-recovery' })
  })
})
