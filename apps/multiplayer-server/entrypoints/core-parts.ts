import { DeltaTimeSecs, type ChunkCoord } from '@nerima-games/mc-kernel'
import { ChunkCapacity, makeChunkStore, type ChunkStoreApi, type ReadonlyChunkWithBlockStates } from '@nerima-games/mc-worldgen'
import {
  makeInMemoryVitals,
  openChunkWindow,
  makeSurvivalHungerRuntime,
  SPAWN_PLAYER_VITALS,
  SURVIVAL_HUNGER_STATE_VERSION,
  type SurvivalHungerError,
  type SurvivalHungerRuntimeApi,
  type SurvivalHungerState,
  type ChunkWindow,
} from '@nerima-games/mx-gameplay'
import { Effect, Result } from 'effect'

import type { MultiplayerServerCoreParts } from '../core.js'
import { makeServerWorldWrite } from '../world-write-port.js'

// Bounds resident terrain. Evicted chunks regenerate through the source and its saved block overrides.
const CHUNK_STORE_CAPACITY = Result.getOrThrow(ChunkCapacity.result(256))

/** Runs one mx-gameplay hunger operation on a runtime restored from `state` and returns the next state. */
const stepHunger = <A>(
  state: SurvivalHungerState,
  operation: (runtime: SurvivalHungerRuntimeApi) => Effect.Effect<A, SurvivalHungerError>,
): Result.Result<Readonly<{ value: A; state: SurvivalHungerState }>, SurvivalHungerError> =>
  Effect.runSync(Effect.result(Effect.gen(function* () {
    const runtime = yield* makeSurvivalHungerRuntime(state)
    const value = yield* operation(runtime)
    return { value, state: yield* runtime.snapshot }
  })))

const chunkKey = (coord: ChunkCoord): string => `${String(coord.cx)},${String(coord.cz)}`

/**
 * Opens a ChunkWindow over exactly `chunks`, the values the core loaded, without copying them. openChunkWindow needs a
 * ChunkStoreApi but reads it only through `peek`, once per coord it was given (mx-gameplay chunk-window.js 149-156), so
 * a store that answers `peek` from these values is enough. Narrowing openChunkWindow's parameter upstream to
 * `Pick<ChunkStoreApi, 'peek'>` would remove this shim.
 */
const openWindowOver = (chunks: ReadonlyArray<ReadonlyChunkWithBlockStates>): ChunkWindow => {
  const given = new Map(chunks.map((chunk) => [chunkKey(chunk.coord), chunk]))
  // openChunkWindow peeks only the coords passed below, all of which are given. A coord that was not given would read
  // as unloaded and silently hold a mob in place, so it dies instead of answering undefined.
  const peek = (coord: ChunkCoord) => {
    const chunk = given.get(chunkKey(coord))
    return chunk === undefined ? Effect.die(new Error(`openChunkWindow peeked chunk ${chunkKey(coord)}, which was not given`)) : Effect.succeed(chunk)
  }
  // openChunkWindow calls no other member (chunk-window.js 149-156), so each of them dies if it is ever called.
  const unused = Effect.die(new Error('openChunkWindow reads its store only through peek'))
  const store: ChunkStoreApi = {
    prepare: () => unused,
    publish: () => unused,
    load: () => unused,
    peek,
    snapshot: () => unused,
    isLoaded: () => unused,
    loadedCoords: unused,
    neighbours: () => unused,
    unload: () => unused,
    getBlock: () => unused,
    getBlockWithState: () => unused,
    setBlock: () => unused,
    getLight: () => unused,
    subscribeDirty: unused,
    subscribeDirtyScoped: unused,
    reset: unused,
  }
  return Effect.runSync(openChunkWindow(store, [...given.values()].map((chunk) => chunk.coord)))
}

/**
 * Builds the synchronous parts the multiplayer server core uses, so Effect runs stay at the entrypoint.
 * The server entrypoint and the tests that construct a core both build their parts here.
 */
export const makeMultiplayerServerCoreParts = (): MultiplayerServerCoreParts => ({
  makeWorldWrite: (options) => Effect.runSync(Effect.result(makeServerWorldWrite(options))),
  survivalHunger: {
    create: (vitals, difficulty) => Effect.runSync(Effect.gen(function* () {
      // The in-memory vitals normalise spawn saturation against the given hunger.
      const initial = yield* makeInMemoryVitals({ ...SPAWN_PLAYER_VITALS, ...vitals })
      return { version: SURVIVAL_HUNGER_STATE_VERSION, difficulty, vitals: yield* initial.snapshot }
    })),
    // A zero-length tick applies the submitted activity now; mx-gameplay drops it on peaceful difficulty.
    activity: (state, input) => Result.map(stepHunger(state, (runtime) => Effect.gen(function* () {
      yield* runtime.submit(input)
      return yield* runtime.tick(yield* Effect.fromResult(DeltaTimeSecs.result(0)))
    })), (step) => step.state),
    eat: (state, foodPoints, saturationModifier) =>
      Result.map(stepHunger(state, (runtime) => runtime.eat(foodPoints, saturationModifier)), (step) => step.state),
    respawn: (state) => Result.map(stepHunger(state, (runtime) => runtime.respawn), (step) => step.state),
    tick: (state, elapsed) => Result.map(stepHunger(state, (runtime) => runtime.tick(elapsed)), (step) => ({ state: step.state, died: step.value.died })),
  },
  openChunkStore: (source) => {
    const store = Effect.runSync(makeChunkStore(source, CHUNK_STORE_CAPACITY))
    return {
      store,
      peek: (coord) => Effect.runSync(store.peek(coord)),
      load: (coord) => Effect.runSync(Effect.result(store.load(coord))),
      unload: (coord) => Effect.runSync(Effect.result(store.unload(coord))),
      openWindow: openWindowOver,
    }
  },
})
