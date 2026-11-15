/* eslint-disable max-lines, no-magic-numbers -- Sleep synchronization is a small protocol adapter with explicit boundary validation. */
import { BlockAxis, PositionAxis, type DimensionRevision, type SimulationTick } from '@nerima-games/mc-kernel'
import type { Intent } from '@nerima-games/mc-sim'
import {
  DEFAULT_BLOCK_REACH,
  enterSleep,
  initialSleepRuntimeState,
  leaveSleep,
  requiredSleeperCount,
  sleepRatioFromPercentage,
  type SleepLocation,
  type SleepRuntimeState,
} from '@nerima-games/mx-gameplay'
import {
  SurvivalAuthority,
  type PlayerId,
  type SurvivalActorState,
  type SurvivalEvent,
  type SurvivalItemStack,
  type SurvivalPosition,
  type SurvivalRejectionReason,
  type SurvivalSleepState,
  type SurvivalSleepValidation,
  type SurvivalSleepValidationInput,
  type SurvivalSnapshot,
} from '@nerima-games/mx-multiplayer'
import { Brand, Result } from 'effect'

import { parseWireJson } from './parse-wire-json.js'

type SleepCommandHeader = {
  readonly actor: PlayerId
  readonly session: string
  readonly requestId: string
  readonly expectedRevision: number
  readonly clientTick: number
}

export type SleepCommand = SleepCommandHeader & (
  | { readonly _tag: 'EnterSleep'; readonly bed: SurvivalPosition }
  | { readonly _tag: 'LeaveSleep' }
)

/**
 * Rejections this adapter can produce. mx-gameplay has no sleep-command cooldown rule, and the
 * LeaveSleep authority only rejects malformed headers, so those mx-multiplayer reasons never occur.
 */
export type SleepRejectionReason = Exclude<SurvivalRejectionReason, 'cooldown-active' | 'authority-boundary-unsupported'>

export type SleepCommandResult =
  | {
      readonly accepted: true
      readonly requestId: string
      readonly revision: number
      readonly events: ReadonlyArray<SurvivalEvent>
    }
  | {
      readonly accepted: false
      readonly requestId: string
      readonly revision: number
      readonly reason: SleepRejectionReason
    }

export type SleepWireMessage =
  | { readonly _tag: 'SleepCommand'; readonly command: SleepCommand }
  | { readonly _tag: 'SleepCommandResult'; readonly result: SleepCommandResult }
  | { readonly _tag: 'SleepSnapshot'; readonly snapshot: SurvivalSnapshot }
  | { readonly _tag: 'SleepEvents'; readonly revision: number; readonly events: ReadonlyArray<SurvivalEvent> }

export const SLEEP_MAX_WIRE_LENGTH = 1_048_576
export const SLEEP_MAX_IDENTIFIER_LENGTH = 128

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= SLEEP_MAX_IDENTIFIER_LENGTH
  && !/\p{Cc}/u.test(value)

const isFiniteInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)

const isPosition = (value: unknown): value is SurvivalPosition =>
  isRecord(value) && isFiniteInteger(value['x']) && isFiniteInteger(value['y']) && isFiniteInteger(value['z'])

const isItemStack = (value: unknown): value is SurvivalItemStack =>
  isRecord(value) && typeof value['item'] === 'string' && isFiniteInteger(value['count']) && value['count'] > 0

const isDrop = (value: unknown): boolean =>
  isRecord(value) && typeof value['item'] === 'string' && isFiniteInteger(value['count']) && value['count'] > 0 && isPosition(value['at'])

const isSleepState = (value: unknown): value is SurvivalSleepState =>
  isRecord(value) && typeof value['dimension'] === 'string' && isPosition(value['bed'])

const isActorState = (value: unknown): value is SurvivalActorState =>
  isRecord(value)
  && isIdentifier(value['player'])
  && isIdentifier(value['session'])
  && isPosition(value['position'])
  && (value['gameMode'] === 'survival' || value['gameMode'] === 'creative' || value['gameMode'] === 'spectator')
  && Array.isArray(value['inventory'])
  && value['inventory'].every((stack) => stack === null || isItemStack(stack))
  && typeof value['health'] === 'number'
  && Number.isFinite(value['health'])
  && isPosition(value['spawn'])
  && isFiniteInteger(value['lastActionTick'])
  && (value['sleeping'] === undefined || isSleepState(value['sleeping']))

const isSurvivalEvent = (value: unknown): value is SurvivalEvent => {
  if (!isRecord(value)) return false
  if (value['_tag'] === 'InventoryChanged') {
    return isIdentifier(value['actor']) && isFiniteInteger(value['slot']) && (value['stack'] === null || isItemStack(value['stack']))
  }
  if (value['_tag'] === 'BlockChanged') return isPosition(value['at']) && (value['block'] === null || typeof value['block'] === 'string')
  if (value['_tag'] === 'ActorDamaged') {
    return isIdentifier(value['actor']) && typeof value['source'] === 'string' && typeof value['health'] === 'number' && Number.isFinite(value['health'])
  }
  if (value['_tag'] === 'ActorDied') return isIdentifier(value['actor']) && typeof value['killer'] === 'string'
  if (value['_tag'] === 'ItemDropped') return typeof value['item'] === 'string' && isFiniteInteger(value['count']) && value['count'] > 0 && isPosition(value['at'])
  if (value['_tag'] === 'ActorRespawned') return isIdentifier(value['actor']) && isPosition(value['at']) && typeof value['health'] === 'number' && Number.isFinite(value['health'])
  if (value['_tag'] === 'ActorSleepChanged') return isIdentifier(value['actor']) && (value['sleeping'] === null || isSleepState(value['sleeping']))
  if (value['_tag'] === 'SleepProgress') {
    return isFiniteInteger(value['sleeping']) && isFiniteInteger(value['required']) && isFiniteInteger(value['connected']) && typeof value['ready'] === 'boolean'
  }
  return value['_tag'] === 'NightSkipped' && isFiniteInteger(value['sleeping']) && isFiniteInteger(value['required'])
}

const isRejectionReason = (value: unknown): value is SleepRejectionReason =>
  value === 'duplicate-request'
  || value === 'stale-revision'
  || value === 'unauthorized-actor'
  || value === 'session-mismatch'
  || value === 'invalid-command'
  || value === 'invalid-game-mode'
  || value === 'out-of-reach'
  || value === 'insufficient-items'
  || value === 'occupied'
  || value === 'missing-block'
  || value === 'target-not-found'
  || value === 'target-dead'
  || value === 'actor-dead'
  || value === 'target-alive'
  || value === 'invalid-bed'
  || value === 'not-sleep-time'
  || value === 'sleep-unsafe'
  || value === 'already-sleeping'
  || value === 'not-sleeping'

const isCommandResult = (value: unknown): value is SleepCommandResult =>
  isRecord(value)
  && isIdentifier(value['requestId'])
  && isFiniteInteger(value['revision'])
  && ((value['accepted'] === true && Array.isArray(value['events']) && value['events'].every(isSurvivalEvent))
    || (value['accepted'] === false && isRejectionReason(value['reason'])))

const isSnapshot = (value: unknown): value is SurvivalSnapshot =>
  isRecord(value)
  && typeof value['world'] === 'string'
  && isFiniteInteger(value['revision'])
  && Array.isArray(value['actors'])
  && value['actors'].every(isActorState)
  && isRecord(value['blocks'])
  && Object.values(value['blocks']).every((block) => typeof block === 'string')
  && Array.isArray(value['drops'])
  && value['drops'].every(isDrop)

const isSleepCommand = (value: unknown): value is SleepCommand => {
  if (!isRecord(value) || (value['_tag'] !== 'EnterSleep' && value['_tag'] !== 'LeaveSleep')) return false
  const validBase = isIdentifier(value['actor'])
    && isIdentifier(value['session'])
    && isIdentifier(value['requestId'])
    && isFiniteInteger(value['expectedRevision'])
    && isFiniteInteger(value['clientTick'])
  return validBase && (value['_tag'] === 'LeaveSleep' || isPosition(value['bed']))
}

export const decodeSleepWireMessage = (frame: string): SleepWireMessage | undefined => {
  if (frame.length > SLEEP_MAX_WIRE_LENGTH) return undefined
  const value = parseWireJson(frame)
  if (!isRecord(value)) return undefined
  if (value['_tag'] === 'SleepCommand' && isSleepCommand(value['command'])) return { _tag: 'SleepCommand', command: value['command'] }
  if (value['_tag'] === 'SleepCommandResult' && isCommandResult(value['result'])) return { _tag: 'SleepCommandResult', result: value['result'] }
  if (value['_tag'] === 'SleepEvents') {
    if (isFiniteInteger(value['revision']) && Array.isArray(value['events']) && value['events'].every(isSurvivalEvent)) {
      return { _tag: 'SleepEvents', revision: value['revision'], events: value['events'] }
    }
  }
  if (value['_tag'] === 'SleepSnapshot' && isSnapshot(value['snapshot'])) return { _tag: 'SleepSnapshot', snapshot: value['snapshot'] }
  return undefined
}

export type SleepClientState = {
  readonly revision: number
  readonly sleepers: ReadonlyMap<PlayerId, SurvivalSleepState>
  readonly pending: ReadonlyMap<string, SleepCommand>
  readonly progress: Extract<SurvivalEvent, { readonly _tag: 'SleepProgress' }> | null
  readonly skippedRevision: number | null
  readonly rejection: SleepCommandResult | null
}

export const initialSleepClientState = (): SleepClientState => ({
  revision: 0,
  sleepers: new Map(),
  pending: new Map(),
  progress: null,
  skippedRevision: null,
  rejection: null,
})

export const sleepClientFromSnapshot = (snapshot: SurvivalSnapshot): SleepClientState => ({
  ...initialSleepClientState(),
  revision: snapshot.revision,
  sleepers: new Map(snapshot.actors.flatMap((actor) =>
    actor.sleeping === undefined ? [] : [[actor.player, actor.sleeping] as const],
  )),
})

export const queueSleepCommand = (
  state: SleepClientState,
  command: SleepCommand,
): SleepClientState => ({
  ...state,
  pending: new Map(state.pending).set(command.requestId, command),
  rejection: null,
})

const applyEvents = (
  state: SleepClientState,
  revision: number,
  events: ReadonlyArray<SurvivalEvent>,
): SleepClientState => {
  if (revision < state.revision) return state
  const sleepers = new Map(state.sleepers)
  let progress = state.progress
  let skippedRevision = state.skippedRevision
  for (const event of events) {
    if (event._tag === 'ActorSleepChanged') {
      if (event.sleeping === null) sleepers.delete(event.actor)
      else sleepers.set(event.actor, event.sleeping)
    } else if (event._tag === 'SleepProgress') {
      progress = event
    } else if (event._tag === 'NightSkipped' && skippedRevision !== revision) {
      skippedRevision = revision
      sleepers.clear()
    }
  }
  return { ...state, revision, sleepers, progress, skippedRevision }
}

export const applySleepCommandResult = (
  state: SleepClientState,
  result: SleepCommandResult,
): SleepClientState => {
  const pending = new Map(state.pending)
  pending.delete(result.requestId)
  if (!result.accepted) {
    return { ...state, revision: Math.max(state.revision, result.revision), pending, rejection: result }
  }
  return { ...applyEvents(state, result.revision, result.events), pending, rejection: null }
}

export const applySleepEvents = (
  state: SleepClientState,
  revision: number,
  events: ReadonlyArray<SurvivalEvent>,
): SleepClientState => applyEvents(state, revision, events)

export type SleepRatio = number & Brand.Brand<'SleepRatio'>
const SleepRatio = Brand.nominal<SleepRatio>()

/** Parses a players-sleeping percentage with mx-gameplay's rule; `null` requires every player. */
export const sleepRatio = (percentage: string | null): Result.Result<SleepRatio, 'invalid-sleep-percentage'> =>
  Result.map(sleepRatioFromPercentage(percentage), SleepRatio)

export type SleepAuthorityOptions = {
  readonly sleepRatio: SleepRatio
  /** Bed reach from the actor's snapshot position; defaults to mx-gameplay's DEFAULT_BLOCK_REACH. */
  readonly reach?: number
  readonly validateSleep: (input: SurvivalSleepValidationInput) => SurvivalSleepValidation
}

/** Fields the server supplies when it turns a sleep command into a C2 intent. */
export type SleepIntentContext = {
  readonly targetTick: SimulationTick
  readonly expectedDimensionRevision: DimensionRevision
}

export type SleepAwakeActor = Omit<SurvivalActorState, 'sleeping'>

type SleepState = {
  readonly snapshot: SurvivalSnapshot
  readonly roster: SleepRuntimeState
}

type SleepAccepted = {
  readonly accepted: true
  readonly actors: ReadonlyArray<SurvivalActorState>
  readonly roster: SleepRuntimeState
  readonly events: ReadonlyArray<SurvivalEvent>
}

type SleepDecision = { readonly accepted: false; readonly reason: SleepRejectionReason } | SleepAccepted

const isBlockPosition = (position: SurvivalPosition): boolean =>
  Number.isSafeInteger(position.x) && Number.isSafeInteger(position.y) && Number.isSafeInteger(position.z)

// mx-gameplay's roster models overworld beds only; the wire keeps the validator's dimension label.
const sleepLocationOf = (bed: SurvivalPosition): Result.Result<SleepLocation, Brand.BrandError> =>
  Result.map(
    Result.all({
      blockX: BlockAxis.result(bed.x),
      blockY: BlockAxis.result(bed.y),
      blockZ: BlockAxis.result(bed.z),
      x: PositionAxis.result(bed.x),
      y: PositionAxis.result(bed.y),
      z: PositionAxis.result(bed.z),
    }),
    ({ blockX, blockY, blockZ, x, y, z }): SleepLocation => ({
      dimension: 'overworld',
      position: { x, y, z },
      bedPosition: { x: blockX, y: blockY, z: blockZ },
    }),
  )

const awake = (actor: SurvivalActorState): SleepAwakeActor => {
  const { sleeping: _sleeping, ...rest } = actor
  return rest
}

const isSleeper = (roster: SleepRuntimeState, actor: string): boolean =>
  roster.sleepers.some((sleeper) => sleeper.playerId === actor)

const leavingActor = (intent: Intent): Result.Result<string, Intent> =>
  intent.payload._tag === 'LeaveSleep' ? Result.succeed(intent.payload.actor) : Result.fail(intent)

/**
 * Server-side sleep state. The sleeper roster is mx-gameplay state; the wire snapshot mirrors it,
 * and every accepted decision advances the revision once.
 */
export class SleepAuthority {
  readonly #authority = new SurvivalAuthority()
  readonly #options: SleepAuthorityOptions
  readonly #requests = new Set<string>()
  #state: SleepState

  private constructor(state: SleepState, options: SleepAuthorityOptions) {
    this.#state = state
    this.#options = options
  }

  static make(snapshot: SurvivalSnapshot, options: SleepAuthorityOptions): Result.Result<SleepAuthority, Brand.BrandError> {
    let roster = initialSleepRuntimeState()
    for (const actor of snapshot.actors) {
      if (actor.sleeping === undefined) continue
      const location = sleepLocationOf(actor.sleeping.bed)
      if (Result.isFailure(location)) return Result.fail(location.failure)
      roster = enterSleep(roster, actor.player, location.success)
    }
    return Result.succeed(new SleepAuthority({ snapshot, roster }, options))
  }

  addActor(actor: SleepAwakeActor): SurvivalSnapshot {
    const { snapshot, roster } = this.#state
    if (snapshot.actors.some((candidate) => candidate.player === actor.player)) return snapshot
    this.#state = { snapshot: { ...snapshot, actors: [...snapshot.actors, actor] }, roster }
    return this.#state.snapshot
  }

  execute(command: SleepCommand, context: SleepIntentContext): SleepCommandResult {
    const key = `${command.session}\u0000${command.requestId}`
    const { revision } = this.#state.snapshot
    if (this.#requests.has(key)) {
      return { accepted: false, requestId: command.requestId, revision, reason: 'duplicate-request' }
    }
    this.#requests.add(key)
    const decision = this.#decide(command, context)
    if (!decision.accepted) return { accepted: false, requestId: command.requestId, revision, reason: decision.reason }
    this.#commit(decision)
    return { accepted: true, requestId: command.requestId, revision: this.#state.snapshot.revision, events: decision.events }
  }

  snapshot(): SurvivalSnapshot {
    return this.#state.snapshot
  }

  disconnect(actor: PlayerId): ReadonlyArray<SurvivalEvent> {
    const { snapshot, roster } = this.#state
    if (!snapshot.actors.some((candidate) => candidate.player === actor)) return []
    const prefix: ReadonlyArray<SurvivalEvent> = isSleeper(roster, actor)
      ? [{ _tag: 'ActorSleepChanged', actor, sleeping: null }]
      : []
    const decision = this.#progress(
      prefix,
      snapshot.actors.filter((candidate) => candidate.player !== actor),
      leaveSleep(roster, actor),
    )
    this.#commit(decision)
    return decision.events
  }

  reconcile(): ReadonlyArray<SurvivalEvent> {
    const { snapshot, roster } = this.#state
    let nextRoster = roster
    const removed: SurvivalEvent[] = []
    for (const actor of snapshot.actors) {
      if (actor.sleeping === undefined) continue
      const validation = this.#options.validateSleep({ actor, bed: actor.sleeping.bed, snapshot })
      if (validation.bedValid && validation.dimension === actor.sleeping.dimension && actor.health > 0 && actor.gameMode === 'survival') continue
      nextRoster = leaveSleep(nextRoster, actor.player)
      removed.push({ _tag: 'ActorSleepChanged', actor: actor.player, sleeping: null })
    }
    if (removed.length === 0) return []
    const decision = this.#progress(removed, snapshot.actors, nextRoster)
    this.#commit(decision)
    return decision.events
  }

  rejoin(actor: PlayerId, previousSession: string, nextSession: string): boolean {
    if (nextSession.length === 0) return false
    const { snapshot, roster } = this.#state
    const current = snapshot.actors.find((candidate) => candidate.player === actor)
    if (current === undefined || current.session !== previousSession) return false
    const actors = snapshot.actors.map((candidate) => candidate.player === actor ? { ...candidate, session: nextSession } : candidate)
    this.#state = { snapshot: { ...snapshot, actors }, roster }
    return true
  }

  #commit(decision: SleepAccepted): void {
    const { snapshot } = this.#state
    this.#state = {
      snapshot: { ...snapshot, actors: decision.actors, revision: snapshot.revision + 1 },
      roster: decision.roster,
    }
  }

  #decide(command: SleepCommand, context: SleepIntentContext): SleepDecision {
    const { snapshot } = this.#state
    if (command.requestId.length === 0 || command.session.length === 0) return { accepted: false, reason: 'invalid-command' }
    if (command.expectedRevision !== snapshot.revision) return { accepted: false, reason: 'stale-revision' }
    const actor = snapshot.actors.find((candidate) => candidate.player === command.actor)
    if (actor === undefined) return { accepted: false, reason: 'unauthorized-actor' }
    if (actor.session !== command.session) return { accepted: false, reason: 'session-mismatch' }
    return command._tag === 'LeaveSleep'
      ? this.#leave(command, actor, context)
      : this.#enter(command, actor)
  }

  #leave(command: Extract<SleepCommand, { readonly _tag: 'LeaveSleep' }>, actor: SurvivalActorState, context: SleepIntentContext): SleepDecision {
    const { snapshot, roster } = this.#state
    if (!isSleeper(roster, actor.player)) return { accepted: false, reason: 'not-sleeping' }
    const result = this.#authority.execute({
      _tag: 'LeaveSleep',
      actor: command.actor,
      session: command.session,
      requestId: command.requestId,
      expectedRevision: command.expectedRevision,
      expectedDimensionRevision: context.expectedDimensionRevision,
    }, context.targetTick)
    // SurvivalAuthority supports LeaveSleep, so it rejects one only when header validation fails.
    if (!result.accepted) return { accepted: false, reason: 'invalid-command' }
    // SurvivalAuthority maps a LeaveSleep command only to a LeaveSleep intent.
    const leaving = Result.getOrThrow(leavingActor(result.intent))
    return this.#progress(
      [{ _tag: 'ActorSleepChanged', actor: actor.player, sleeping: null }],
      snapshot.actors,
      leaveSleep(roster, leaving),
    )
  }

  #enter(command: Extract<SleepCommand, { readonly _tag: 'EnterSleep' }>, actor: SurvivalActorState): SleepDecision {
    const { snapshot, roster } = this.#state
    if (actor.health <= 0) return { accepted: false, reason: 'actor-dead' }
    if (actor.gameMode !== 'survival') return { accepted: false, reason: 'invalid-game-mode' }
    if (!isBlockPosition(command.bed)) return { accepted: false, reason: 'invalid-command' }
    if (isSleeper(roster, actor.player)) return { accepted: false, reason: 'already-sleeping' }
    const reach = this.#options.reach ?? DEFAULT_BLOCK_REACH
    const offset = { x: actor.position.x - command.bed.x, y: actor.position.y - command.bed.y, z: actor.position.z - command.bed.z }
    if (offset.x ** 2 + offset.y ** 2 + offset.z ** 2 > reach ** 2) return { accepted: false, reason: 'out-of-reach' }
    const validation = this.#options.validateSleep({ actor, bed: command.bed, snapshot })
    if (!validation.bedValid) return { accepted: false, reason: 'invalid-bed' }
    if (!validation.nightOrThunder) return { accepted: false, reason: 'not-sleep-time' }
    if (!validation.safe) return { accepted: false, reason: 'sleep-unsafe' }
    // isBlockPosition admitted only safe integers, which satisfy both axis brands.
    const location = Result.getOrThrow(sleepLocationOf(command.bed))
    const sleeping: SurvivalSleepState = { dimension: validation.dimension, bed: { ...command.bed } }
    const actors = snapshot.actors.map((candidate) => candidate.player === actor.player
      ? { ...candidate, sleeping, lastActionTick: command.clientTick }
      : candidate)
    return this.#progress(
      [{ _tag: 'ActorSleepChanged', actor: actor.player, sleeping }],
      actors,
      enterSleep(roster, actor.player, location),
    )
  }

  /** Projects the roster onto the actors and skips the night once mx-gameplay's threshold is met. */
  #progress(
    prefix: ReadonlyArray<SurvivalEvent>,
    candidates: ReadonlyArray<SurvivalActorState>,
    roster: SleepRuntimeState,
  ): SleepAccepted {
    const actors = candidates.map((actor) => isSleeper(roster, actor.player) ? actor : awake(actor))
    const connected = actors.filter((actor) => actor.gameMode === 'survival').length
    const sleeping = actors.filter((actor) => actor.gameMode === 'survival' && actor.health > 0 && isSleeper(roster, actor.player)).length
    // SleepRatio values only come from sleepRatioFromPercentage, which yields finite ratios.
    const required = Result.getOrThrow(requiredSleeperCount(connected, this.#options.sleepRatio))
    const ready = sleeping >= required
    const progress: SurvivalEvent = { _tag: 'SleepProgress', sleeping, required, connected, ready }
    if (!ready) return { accepted: true, actors, roster, events: [...prefix, progress] }
    return {
      accepted: true,
      actors: actors.map(awake),
      roster: roster.sleepers.reduce((next, sleeper) => leaveSleep(next, sleeper.playerId), roster),
      events: [...prefix, progress, { _tag: 'NightSkipped', sleeping, required }],
    }
  }
}

export const actorSleepLocation = (actor: SurvivalActorState): SurvivalSleepState | undefined => actor.sleeping
