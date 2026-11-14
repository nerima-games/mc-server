import {
  makeRuntimeRedstoneStages,
  PistonBlockOffsetSchema,
  pistonPositionAt,
  planPistonTransition,
  RedstoneWorldRuntime,
  RedstoneWorldRuntimeLayer,
  type RedstoneComponentSnapshot,
  type RedstonePosition,
} from '@nerima-games/mx-redstone'
import { blockIdOf, capabilityOfBlockId, DeltaTimeSecs, isBlockType } from '@nerima-games/mc-kernel'
import { Context, Effect, Layer, Option, Result, Schema, Scope } from 'effect'

import { ServerClockLayer } from './clock.js'
import type { MultiplayerServerCore, MultiplayerServerCoreFailure } from './core.js'

const lampBlocks = new Set(['redstone_lamp', 'redstone_lamp_lit'] as const)
const doorBlocks = new Set(['door', 'door_open'] as const)
type ResultFailure<Value> = Value extends Result.Result<unknown, infer Failure> ? Failure : never
type PistonHeadOffsetResult = Result.Result<Schema.Schema.Type<typeof PistonBlockOffsetSchema>, Schema.SchemaError>
const pistonHeadOffsetResult: PistonHeadOffsetResult = Schema.decodeUnknownResult(PistonBlockOffsetSchema)(1)
type PistonHeadOffsetFailure = ResultFailure<PistonHeadOffsetResult>
type PistonCapabilityFailure =
  | Readonly<{ _tag: 'UnknownBlockType'; block: string }>
  | Readonly<{ _tag: 'UnregisteredBlockType'; block: string }>
  | Readonly<{ _tag: 'BlockCapabilityResolutionFailure'; failure: ResultFailure<ReturnType<typeof capabilityOfBlockId>> }>
type PistonCapabilityResult = ReturnType<typeof capabilityOfBlockId>

const makePistonCapabilities = (): Readonly<{
  readonly capabilities: Readonly<{ pistonImmovable: (block: string) => PistonCapabilityResult }>
  readonly failure: () => PistonCapabilityFailure | undefined
}> => {
  let failure: PistonCapabilityFailure | undefined
  return {
    capabilities: {
      pistonImmovable: (block) => {
        if (!isBlockType(block)) {
          failure ??= { _tag: 'UnknownBlockType', block }
          return Result.succeed(true)
        }
        const blockId = blockIdOf(block)
        if (Option.isNone(blockId)) {
          failure ??= { _tag: 'UnregisteredBlockType', block }
          return Result.succeed(true)
        }
        const capability = capabilityOfBlockId(blockId.value, 'pistonImmovable')
        if (Result.isFailure(capability)) {
          failure ??= { _tag: 'BlockCapabilityResolutionFailure', failure: capability.failure }
          return Result.succeed(true)
        }
        return Result.succeed(capability.success)
      },
    },
    failure: () => failure,
  }
}

export interface MultiplayerRedstoneRealm {
  readonly dimension: string
  readonly core: MultiplayerServerCore
}

export interface MultiplayerRedstoneRuntime {
  readonly tick: (elapsedMs: number) => Result.Result<void, MultiplayerRedstoneTickFailure>
}

type RedstoneTickFailure = ReturnType<typeof DeltaTimeSecs.result> extends Result.Result<unknown, infer Failure> ? Failure : never

export type MultiplayerRedstoneTickFailure =
  | Readonly<{ _tag: 'InvalidRedstoneTickDuration'; elapsedMs: number }>
  | Readonly<{ _tag: 'RedstoneDeltaTimeFailure'; failure: RedstoneTickFailure }>
  | Readonly<{ _tag: 'CoreBlockReadFailure'; failure: MultiplayerServerCoreFailure }>
  | Readonly<{ _tag: 'PistonCapabilityFailure'; failure: PistonCapabilityFailure }>
  | Readonly<{ _tag: 'PistonHeadOffsetFailure'; failure: PistonHeadOffsetFailure }>

const componentForBlock = (
  core: MultiplayerServerCore,
  block: string | null,
  position: RedstonePosition,
): Result.Result<RedstoneComponentSnapshot | undefined, MultiplayerRedstoneTickFailure> => {
  switch (block) {
    case 'hopper':
      return Result.succeed({ position, kind: 'hopper' })
    case 'dispenser':
      return Result.succeed({ position, kind: 'dispenser' })
    case 'dropper':
      return Result.succeed({ position, kind: 'dropper' })
    case 'redstone_torch':
      return Result.succeed({ position, kind: 'torch' })
    case 'redstone_wire':
      return Result.succeed({ position, kind: 'wire' })
    case 'powered_rail': {
      const powered = core.isPoweredRailPowered(position)
      if (Result.isFailure(powered)) return Result.fail({ _tag: 'CoreBlockReadFailure', failure: powered.failure })
      return Result.succeed({ position, kind: 'powered-rail', powered: powered.success })
    }
    case 'lever': {
      const active = core.isLeverActive(position)
      if (Result.isFailure(active)) return Result.fail({ _tag: 'CoreBlockReadFailure', failure: active.failure })
      return Result.succeed({ position, kind: 'lever', active: active.success })
    }
    case 'comparator': {
      const inputFrom = { x: position.x, y: position.y, z: position.z + 1 }
      const containerSlots = core.readContainerSlots(inputFrom)
      if (Result.isFailure(containerSlots)) return Result.fail({ _tag: 'CoreBlockReadFailure', failure: containerSlots.failure })
      return Result.succeed({
        position,
        kind: 'comparator',
        inputFrom,
        outputTo: { x: position.x, y: position.y, z: position.z - 1 },
        sideInputs: [
          { x: position.x - 1, y: position.y, z: position.z },
          { x: position.x + 1, y: position.y, z: position.z },
        ],
        mode: 'compare',
        ...(containerSlots.success === undefined ? {} : { containerSlots: containerSlots.success }),
      })
    }
    case 'redstone_lamp':
    case 'redstone_lamp_lit':
      return Result.succeed({ position, kind: 'lamp' })
    case 'door':
    case 'door_open':
      return Result.succeed({ position, kind: 'door' })
    case 'piston': {
      if (Result.isFailure(pistonHeadOffsetResult)) {
        return Result.fail({ _tag: 'PistonHeadOffsetFailure', failure: pistonHeadOffsetResult.failure })
      }
      const head = core.readPistonCell(pistonPositionAt(position, 'north', pistonHeadOffsetResult.success))
      if (Result.isFailure(head)) return Result.fail({ _tag: 'CoreBlockReadFailure', failure: head.failure })
      return Result.succeed({
        position,
        kind: 'piston',
        pistonFacing: 'north',
        pistonKind: 'sticky',
        pistonState: head.success.kind === 'block' && head.success.block === 'piston_head' ? 'extended' : 'retracted',
      })
    }
    default:
      return Result.succeed(undefined)
  }
}

/** Bridges mx-redstone events into server-owned gameplay authority. */
export const makeMultiplayerRedstoneRuntime = async (
  realms: ReadonlyArray<MultiplayerRedstoneRealm>,
): Promise<MultiplayerRedstoneRuntime> => {
  const scope = Effect.runSync(Scope.make())
  const context = await Effect.runPromise(
    Effect.provideService(Layer.build(RedstoneWorldRuntimeLayer), Scope.Scope, scope),
  )
  const runtime = Context.get(context, RedstoneWorldRuntime)
  const stages = await Effect.runPromise(Effect.provide(makeRuntimeRedstoneStages, context))
  const realmsByDimension = new Map(realms.map((realm) => [realm.dimension, realm]))

  return {
    tick: (elapsedMs) => {
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
        return Result.fail({ _tag: 'InvalidRedstoneTickDuration', elapsedMs })
      }
      const elapsedSecsResult = DeltaTimeSecs.result(elapsedMs / 1_000)
      if (Result.isFailure(elapsedSecsResult)) {
        return Result.fail({ _tag: 'RedstoneDeltaTimeFailure', failure: elapsedSecsResult.failure })
      }
      for (const realm of realms) {
        const components: Array<RedstoneComponentSnapshot> = []
        for (const { at, block } of realm.core.snapshot().blocks) {
          const component = componentForBlock(realm.core, block, at)
          if (Result.isFailure(component)) return Result.fail(component.failure)
          if (component.success !== undefined) components.push(component.success)
        }
        Effect.runSync(runtime.syncSnapshot({ dimension: realm.dimension, components }))
      }
      for (const stage of stages) {
        Effect.runSync(
          stage.run(elapsedSecsResult.success).pipe(Effect.provide(ServerClockLayer)),
        )
      }
      for (const event of Effect.runSync(runtime.drainHopperTransferEvents)) {
        const result = realmsByDimension.get(event.dimension)?.core.applyHopperTransfer(event.position)
        if (result !== undefined && Result.isFailure(result)) return Result.fail({ _tag: 'CoreBlockReadFailure', failure: result.failure })
      }
      for (const event of Effect.runSync(runtime.drainTriggerEvents)) {
        const core = realmsByDimension.get(event.dimension)?.core
        if (core === undefined) continue
        let result: Result.Result<boolean, MultiplayerServerCoreFailure>
        if (event.kind === 'dispenser') {
          result = core.applyDispenserTrigger(event.position)
        } else if (event.kind === 'dropper') {
          result = core.applyDropperTrigger(event.position)
        } else {
          continue
        }
        if (Result.isFailure(result)) return Result.fail({ _tag: 'CoreBlockReadFailure', failure: result.failure })
      }
      for (const event of Effect.runSync(runtime.drainLampTransitions)) {
        const result = realmsByDimension.get(event.dimension)?.core.applyRedstoneBlockState(
          event.position,
          lampBlocks,
          event.lit ? 'redstone_lamp_lit' : 'redstone_lamp',
        )
        if (result !== undefined && Result.isFailure(result)) return Result.fail({ _tag: 'CoreBlockReadFailure', failure: result.failure })
      }
      for (const event of Effect.runSync(runtime.drainPoweredComponentTransitions)) {
        const core = realmsByDimension.get(event.dimension)?.core
        if (event.kind === 'door') {
          const result = core?.applyRedstoneBlockState(event.position, doorBlocks, event.powered ? 'door_open' : 'door')
          if (result !== undefined && Result.isFailure(result)) return Result.fail({ _tag: 'CoreBlockReadFailure', failure: result.failure })
        } else if (event.kind === 'powered-rail') {
          const result = core?.applyPoweredRailState(event.position, event.powered)
          if (result !== undefined && Result.isFailure(result)) return Result.fail({ _tag: 'CoreBlockReadFailure', failure: result.failure })
        }
      }
      for (const event of Effect.runSync(runtime.drainPistonTransitions)) {
        const realm = realmsByDimension.get(event.dimension)
        if (realm === undefined) continue
        const pistonCapabilities = makePistonCapabilities()
        let pistonReadFailure: MultiplayerServerCoreFailure | undefined
        const outcome = planPistonTransition(event, {
          read: (at) => {
            const read = realm.core.readPistonCell(at)
            if (Result.isFailure(read)) {
              pistonReadFailure ??= read.failure
              return { kind: 'out-of-world' }
            }
            return read.success
          },
        }, pistonCapabilities.capabilities)
        if (pistonReadFailure !== undefined) return Result.fail({ _tag: 'CoreBlockReadFailure', failure: pistonReadFailure })
        const capabilityFailure = pistonCapabilities.failure()
        if (capabilityFailure !== undefined) {
          return Result.fail({ _tag: 'PistonCapabilityFailure', failure: capabilityFailure })
        }
        if (outcome.kind === 'failed') {
          return Result.fail({
            _tag: 'PistonCapabilityFailure',
            failure: { _tag: 'BlockCapabilityResolutionFailure', failure: outcome.failure },
          })
        }
        if (outcome.kind === 'move') {
          const result = realm.core.applyPistonPlan(outcome.plan)
          if (Result.isFailure(result)) return Result.fail({ _tag: 'CoreBlockReadFailure', failure: result.failure })
        }
      }
      return Result.succeed(undefined)
    },
  }
}
