import { DeltaTimeSecs } from '@nerima-games/mc-kernel'
import { ChunkCapacity, makeChunkStore } from '@nerima-games/mc-worldgen'
import {
  makeInMemoryVitals,
  openChunkWindow,
  makeSurvivalHungerRuntime,
  SPAWN_PLAYER_VITALS,
  SURVIVAL_HUNGER_STATE_VERSION,
  type SurvivalHungerError,
  type SurvivalHungerRuntimeApi,
  type SurvivalHungerState,
} from '@nerima-games/mx-gameplay'
import { Effect, Result } from 'effect'

import type { MultiplayerServerCoreParts } from '../core.js'

// Bounds resident terrain. The core never writes a chunk, so evicting one only costs regeneration.
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

/**
 * Builds the synchronous parts the multiplayer server core uses, so Effect runs stay at the entrypoint.
 * The server entrypoint and the tests that construct a core both build their parts here.
 */
export const makeMultiplayerServerCoreParts = (): MultiplayerServerCoreParts => ({
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
      peek: (coord) => Effect.runSync(store.peek(coord)),
      load: (coord) => Effect.runSync(Effect.result(store.load(coord))),
      unload: (coord) => Effect.runSync(Effect.result(store.unload(coord))),
      openWindow: (coords) => Effect.runSync(openChunkWindow(store, coords)),
      capacity: CHUNK_STORE_CAPACITY,
    }
  },
})
