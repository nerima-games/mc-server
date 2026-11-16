import { DeltaTimeSecs, type ChunkCoord } from '@nerima-games/mc-kernel'
import { ChunkCapacity, makeChunkStore, type ChunkSource, type ReadonlyChunkWithBlockStates } from '@nerima-games/mc-worldgen'
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

import type { ChunkWindowOpenFailure, MultiplayerServerCoreParts } from '../core.js'

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

const chunkKey = (coord: ChunkCoord): string => `${String(coord.cx)},${String(coord.cz)}`

/**
 * Opens a ChunkWindow over exactly `chunks`. openChunkWindow reads chunks through a store, so this builds a throwaway
 * store whose source answers only from `chunks` and whose capacity is their count: loading each once fills it without
 * evicting any. A coord the source was not given fails closed; the source's error channel names only terrain
 * generation failures, so that case leaves through a defect caught here.
 */
const openWindowOver = (chunks: ReadonlyArray<ReadonlyChunkWithBlockStates>): Result.Result<ChunkWindow, ChunkWindowOpenFailure> => {
  const given = new Map(chunks.map((chunk) => [chunkKey(chunk.coord), chunk]))
  const capacity = ChunkCapacity.result(given.size)
  if (Result.isFailure(capacity)) return Result.fail({ _tag: 'ChunkWindowEmpty', failure: capacity.failure })
  const notGiven: { coord?: ChunkCoord } = {}
  const source: ChunkSource = (coord) => {
    const chunk = given.get(chunkKey(coord))
    if (chunk === undefined) {
      notGiven.coord = coord
      return Effect.die(notGiven)
    }
    // A store chunk owns a writable buffer, so the source hands it a copy of the given block ids. It leaves out the
    // block states: a ChunkWindow and the movement world read block ids only, and validating copied states would
    // cost most of the window's time.
    return Effect.succeed({ coord: chunk.coord, blocks: Uint16Array.from(chunk.blocks), biomes: chunk.biomes })
  }
  return Effect.runSync(Effect.gen(function* () {
    const store = yield* makeChunkStore(source, capacity.success)
    for (const chunk of given.values()) {
      const loaded = yield* Effect.result(store.load(chunk.coord))
      if (Result.isFailure(loaded)) return Result.fail<ChunkWindowOpenFailure>({ _tag: 'ChunkWindowStoreFailure', failure: loaded.failure })
    }
    return Result.succeed(yield* openChunkWindow(store, [...given.values()].map((chunk) => chunk.coord)))
  }).pipe(Effect.catchDefect((defect) => defect === notGiven && notGiven.coord !== undefined
    ? Effect.succeed(Result.fail<ChunkWindowOpenFailure>({ _tag: 'ChunkWindowChunkNotGiven', cx: notGiven.coord.cx, cz: notGiven.coord.cz }))
    : Effect.die(defect))))
}

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
      openWindow: openWindowOver,
    }
  },
})
