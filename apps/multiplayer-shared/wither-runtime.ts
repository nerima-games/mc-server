import { Brand, Result } from 'effect'
import { DeltaTimeSecs, PositionAxis, position, type Position } from '@nerima-games/mc-kernel'
import {
  createWither,
  damageWither,
  matchWitherSummon,
  restoreWither,
  serializeWither,
  stepWither,
  witherSkullProjectile,
  WitherExplosionPower,
  WitherProjectileSpeed,
  WitherSummonMaterial,
  WitherChargeRemainingSecs,
  WitherHealthPoints,
  type WitherDamageKind,
  type BlockCell,
  type WitherDeathDescriptor,
  type WitherSkullProjectileDescriptor,
  type WitherSkullVariant,
  type WitherSnapshot,
  type WitherState,
  type WitherSummonMatch,
} from '@nerima-games/mc-sim'

type NumericPosition = Readonly<{ x: number; y: number; z: number }>

export type RuntimeWither = Readonly<{
  id: string
  dimension: string
  state: WitherState
  rangedCooldownSecs: number
  meleeCooldownSecs: number
  shotsFired: number
}>

export type RuntimeWitherSkull = Readonly<{
  id: string
  ownerId: string
  dimension: string
  descriptor: WitherSkullProjectileDescriptor
  position: Position
  ageSecs: number
}>

export type WitherRuntimeState = Readonly<{
  nextWitherId: number
  nextSkullId: number
  withers: ReadonlyArray<RuntimeWither>
  skulls: ReadonlyArray<RuntimeWitherSkull>
}>

export type WitherRuntimeSnapshot = Readonly<{
  nextWitherId: number
  nextSkullId: number
  withers: ReadonlyArray<Readonly<{
    id: string
    dimension: string
    snapshot: WitherSnapshot
    rangedCooldownSecs: number
    meleeCooldownSecs: number
    shotsFired: number
  }>>
  skulls: ReadonlyArray<RuntimeWitherSkull>
}>

export type WitherRenderDescriptor = Readonly<{
  id: string
  kind: 'wither' | 'wither_skull'
  category: 'hostile'
  feetPosition: Position
  facingRadians?: number
}>

export type WitherExplosion = Readonly<{
  position: Position
  power: number
  destroysResistantBlocks: boolean
}>

export type WitherRuntimeAdvance = Readonly<{
  state: WitherRuntimeState
  explosions: ReadonlyArray<WitherExplosion>
  meleeDamage: number
}>

const RANGED_INTERVAL_SECS = 2
const MELEE_INTERVAL_SECS = 1
const MELEE_RANGE = 2.25
const MELEE_DAMAGE = 8
const SKULL_MAX_AGE_SECS = 12

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactlyKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

const isNonNegativeFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value)

const isWitherPhase = (value: unknown): value is WitherState['phase'] =>
  value === 'charging' || value === 'airborne' || value === 'armoured' || value === 'dead'

const makePosition = (value: NumericPosition): Result.Result<Position, Brand.BrandError> =>
  Result.flatMap(PositionAxis.result(value.x), (x) =>
    Result.flatMap(PositionAxis.result(value.y), (y) =>
      Result.map(PositionAxis.result(value.z), (z) => position(x, y, z)),
    ),
  )

const decodePosition = (value: unknown): Position | undefined => {
  if (!isRecord(value) || !hasExactlyKeys(value, ['x', 'y', 'z'])) return undefined
  const { x, y, z } = value
  if (typeof x !== 'number' || !Number.isFinite(x)
    || typeof y !== 'number' || !Number.isFinite(y)
    || typeof z !== 'number' || !Number.isFinite(z)) return undefined
  const decoded = makePosition({ x, y, z })
  return Result.isFailure(decoded) ? undefined : decoded.success
}

const isWitherSkullVariant = (value: unknown): value is WitherSkullVariant =>
  value === 'normal' || value === 'blue'

const decodeWitherSnapshot = (value: unknown): WitherSnapshot | undefined => {
  if (!isRecord(value) || !hasExactlyKeys(value, ['kind', 'version', 'state'])
    || value['kind'] !== 'wither' || value['version'] !== 1 || !isRecord(value['state'])
    || !hasExactlyKeys(value['state'], ['phase', 'healthPoints', 'chargeRemainingSecs', 'feetPosition', 'velocity'])) return undefined

  const feetPosition = decodePosition(value['state']['feetPosition'])
  const velocity = decodePosition(value['state']['velocity'])
  if (feetPosition === undefined || velocity === undefined) return undefined

  const phase = value['state']['phase']
  const healthPoints = value['state']['healthPoints']
  const chargeRemainingSecs = value['state']['chargeRemainingSecs']
  if (!isWitherPhase(phase) || typeof healthPoints !== 'number' || typeof chargeRemainingSecs !== 'number') return undefined
  const decodedHealth = WitherHealthPoints.result(healthPoints)
  const decodedCharge = WitherChargeRemainingSecs.result(chargeRemainingSecs)
  if (Result.isFailure(decodedHealth) || Result.isFailure(decodedCharge)) return undefined
  return {
    kind: 'wither',
    version: 1,
    state: { phase, healthPoints: decodedHealth.success, chargeRemainingSecs: decodedCharge.success, feetPosition, velocity },
  }
}

const decodeWitherSkullDescriptor = (value: unknown): WitherSkullProjectileDescriptor | undefined => {
  if (!isRecord(value) || !hasExactlyKeys(value, [
    'kind',
    'variant',
    'origin',
    'direction',
    'speed',
    'explosivePower',
    'destroysResistantBlocks',
  ]) || value['kind'] !== 'wither_skull' || !isWitherSkullVariant(value['variant'])
    || typeof value['destroysResistantBlocks'] !== 'boolean') return undefined

  const origin = decodePosition(value['origin'])
  const direction = decodePosition(value['direction'])
  const speedValue = value['speed']
  const explosivePowerValue = value['explosivePower']
  if (typeof speedValue !== 'number' || typeof explosivePowerValue !== 'number') return undefined
  const speed = WitherProjectileSpeed.result(speedValue)
  const explosivePower = WitherExplosionPower.result(explosivePowerValue)
  if (origin === undefined || direction === undefined || Result.isFailure(speed)
    || Result.isFailure(explosivePower)) return undefined

  return {
    kind: 'wither_skull',
    variant: value['variant'],
    origin,
    direction,
    speed: speed.success,
    explosivePower: explosivePower.success,
    destroysResistantBlocks: value['destroysResistantBlocks'],
  }
}

const decodeRuntimeWitherSnapshot = (
  value: unknown,
): WitherRuntimeSnapshot['withers'][number] | undefined => {
  if (!isRecord(value) || !hasExactlyKeys(value, [
    'id',
    'dimension',
    'snapshot',
    'rangedCooldownSecs',
    'meleeCooldownSecs',
    'shotsFired',
  ])) return undefined

  const snapshot = decodeWitherSnapshot(value['snapshot'])
  const rangedCooldownSecs = value['rangedCooldownSecs']
  const meleeCooldownSecs = value['meleeCooldownSecs']
  const shotsFired = value['shotsFired']
  if (!isIdentifier(value['id']) || !isIdentifier(value['dimension']) || snapshot === undefined
    || !isNonNegativeFiniteNumber(rangedCooldownSecs) || !isNonNegativeFiniteNumber(meleeCooldownSecs)
    || !isNonNegativeSafeInteger(shotsFired)) return undefined
  return { id: value['id'], dimension: value['dimension'], snapshot, rangedCooldownSecs, meleeCooldownSecs, shotsFired }
}

const decodeRuntimeWitherSkull = (value: unknown): RuntimeWitherSkull | undefined => {
  if (!isRecord(value) || !hasExactlyKeys(value, ['id', 'ownerId', 'dimension', 'descriptor', 'position', 'ageSecs'])) return undefined
  const descriptor = decodeWitherSkullDescriptor(value['descriptor'])
  const position = decodePosition(value['position'])
  const ageSecs = value['ageSecs']
  if (!isIdentifier(value['id']) || !isIdentifier(value['ownerId']) || !isIdentifier(value['dimension'])
    || descriptor === undefined || position === undefined || !isNonNegativeFiniteNumber(ageSecs)) return undefined
  return { id: value['id'], ownerId: value['ownerId'], dimension: value['dimension'], descriptor, position, ageSecs }
}

export const isValidWitherRuntimeSnapshot = (value: unknown): value is WitherRuntimeSnapshot =>
  isRecord(value)
  && hasExactlyKeys(value, ['nextWitherId', 'nextSkullId', 'withers', 'skulls'])
  && isNonNegativeSafeInteger(value['nextWitherId'])
  && isNonNegativeSafeInteger(value['nextSkullId'])
  && Array.isArray(value['withers'])
  && value['withers'].every((entry) => decodeRuntimeWitherSnapshot(entry) !== undefined)
  && Array.isArray(value['skulls'])
  && value['skulls'].every((entry) => decodeRuntimeWitherSkull(entry) !== undefined)

export const initialWitherRuntimeState = (): WitherRuntimeState => ({
  nextWitherId: 0,
  nextSkullId: 0,
  withers: [],
  skulls: [],
})

export const summonRuntimeWither = (
  runtime: WitherRuntimeState,
  dimension: string,
  position: NumericPosition,
): Result.Result<WitherRuntimeState, Brand.BrandError> =>
  Result.map(makePosition(position), (feetPosition) => {
    const nextWitherId = runtime.nextWitherId + 1
    return {
      ...runtime,
      nextWitherId,
      withers: [...runtime.withers, {
        id: `wither-${String(nextWitherId)}`,
        dimension,
        state: createWither(feetPosition),
        rangedCooldownSecs: RANGED_INTERVAL_SECS,
        meleeCooldownSecs: MELEE_INTERVAL_SECS,
        shotsFired: 0,
      }],
    }
  })

export const matchRuntimeWitherSummon = (
  placedSkull: NumericPosition,
  blockAt: (cell: BlockCell) => string | undefined,
): Result.Result<WitherSummonMatch | undefined, Brand.BrandError> => {
  for (const base of [
    { x: placedSkull.x, y: placedSkull.y - 2, z: placedSkull.z },
    { x: placedSkull.x - 1, y: placedSkull.y - 2, z: placedSkull.z },
    { x: placedSkull.x + 1, y: placedSkull.y - 2, z: placedSkull.z },
    { x: placedSkull.x, y: placedSkull.y - 2, z: placedSkull.z - 1 },
    { x: placedSkull.x, y: placedSkull.y - 2, z: placedSkull.z + 1 },
  ]) {
    const positionedBase = makePosition(base)
    if (Result.isFailure(positionedBase)) return Result.fail(positionedBase.failure)

    let materialFailure: Brand.BrandError | undefined
    const match = matchWitherSummon(positionedBase.success, (cell) => {
      const value = blockAt(cell)
      if (value !== 'soul_sand' && value !== 'soul_soil') return undefined
      const material = WitherSummonMaterial.result(value)
      if (Result.isFailure(material)) {
        materialFailure = material.failure
        return undefined
      }
      return material.success
    })
    if (materialFailure !== undefined) return Result.fail(materialFailure)
    if (Result.isFailure(match)) return match
    if (match.success !== undefined) return match
  }
  return Result.succeed(undefined)
}

export const damageRuntimeWither = (
  runtime: WitherRuntimeState,
  id: string,
  amount: number,
  kind: WitherDamageKind,
): Result.Result<Readonly<{ state: WitherRuntimeState; death: WitherDeathDescriptor | undefined }>, Brand.BrandError> => {
  let death: WitherDeathDescriptor | undefined
  const withers: RuntimeWither[] = []
  for (const wither of runtime.withers) {
    if (wither.id !== id) {
      withers.push(wither)
      continue
    }
    const result = damageWither(wither.state, amount, kind)
    if (Result.isFailure(result)) return Result.fail(result.failure)
    death = result.success.death
    if (result.success.death === undefined) withers.push({ ...wither, state: result.success.state })
  }
  return Result.succeed({ state: { ...runtime, withers }, death })
}

const distance = (
  left: NumericPosition,
  right: NumericPosition,
): number => Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)

export const advanceWitherRuntime = (
  runtime: WitherRuntimeState,
  dimension: string,
  target: NumericPosition,
  deltaSecs: number,
  skullHitsWorld: (from: RuntimeWitherSkull, to: Position) => boolean,
): Result.Result<WitherRuntimeAdvance, Brand.BrandError> => {
  const delta = DeltaTimeSecs.result(deltaSecs)
  if (Result.isFailure(delta)) return Result.fail(delta.failure)
  const targetPosition = makePosition(target)
  if (Result.isFailure(targetPosition)) return Result.fail(targetPosition.failure)
  const targetHead = makePosition({ ...target, y: target.y + 0.9 })
  if (Result.isFailure(targetHead)) return Result.fail(targetHead.failure)

  const explosions: WitherExplosion[] = []
  const withers: RuntimeWither[] = []
  const launched: RuntimeWitherSkull[] = []
  const launchedDelta = new Map<string, number>()
  let nextSkullId = runtime.nextSkullId
  let meleeDamage = 0

  for (const wither of runtime.withers) {
    if (wither.dimension !== dimension) {
      withers.push(wither)
      continue
    }
    const activeDelta = wither.state.phase === 'charging'
      ? Math.max(0, delta.success - wither.state.chargeRemainingSecs)
      : delta.success
    const steppedResult = stepWither(wither.state, delta.success, targetPosition.success)
    if (Result.isFailure(steppedResult)) return Result.fail(steppedResult.failure)
    const stepped = steppedResult.success
    if (stepped.spawnExplosion !== undefined) {
      explosions.push({ ...stepped.spawnExplosion, destroysResistantBlocks: false })
    }
    if (stepped.state.phase === 'charging' || stepped.state.phase === 'dead') {
      withers.push({ ...wither, state: stepped.state })
      continue
    }

    let rangedCooldownSecs = wither.rangedCooldownSecs - activeDelta
    let shotsFired = wither.shotsFired
    if (rangedCooldownSecs <= 0) {
      nextSkullId += 1
      shotsFired += 1
      const origin = makePosition({
        ...stepped.state.feetPosition,
        y: stepped.state.feetPosition.y + 2,
      })
      if (Result.isFailure(origin)) return Result.fail(origin.failure)
      const descriptor = witherSkullProjectile(
        origin.success,
        targetHead.success,
        shotsFired % 3 === 0 ? 'blue' : 'normal',
      )
      const skull: RuntimeWitherSkull = {
        id: `wither-skull-${String(nextSkullId)}`,
        ownerId: wither.id,
        dimension,
        descriptor,
        position: descriptor.origin,
        ageSecs: 0,
      }
      launched.push(skull)
      launchedDelta.set(skull.id, activeDelta)
      rangedCooldownSecs = RANGED_INTERVAL_SECS
    }

    let meleeCooldownSecs = Math.max(0, wither.meleeCooldownSecs - activeDelta)
    if (meleeCooldownSecs === 0 && distance(stepped.state.feetPosition, targetPosition.success) <= MELEE_RANGE) {
      meleeDamage += MELEE_DAMAGE
      meleeCooldownSecs = MELEE_INTERVAL_SECS
    }
    withers.push({ ...wither, state: stepped.state, rangedCooldownSecs, meleeCooldownSecs, shotsFired })
  }

  const skulls: RuntimeWitherSkull[] = []
  for (const skull of [...runtime.skulls, ...launched]) {
    if (skull.dimension !== dimension) {
      skulls.push(skull)
      continue
    }
    const movementDelta = launchedDelta.get(skull.id) ?? delta.success
    const nextPosition = makePosition({
      x: skull.position.x + skull.descriptor.direction.x * skull.descriptor.speed * movementDelta,
      y: skull.position.y + skull.descriptor.direction.y * skull.descriptor.speed * movementDelta,
      z: skull.position.z + skull.descriptor.direction.z * skull.descriptor.speed * movementDelta,
    })
    if (Result.isFailure(nextPosition)) return Result.fail(nextPosition.failure)
    const position = nextPosition.success
    const ageSecs = skull.ageSecs + movementDelta
    const hitPlayer = distance(position, targetHead.success) <= 0.8
    if (hitPlayer || skullHitsWorld(skull, position)) {
      explosions.push({
        position,
        power: skull.descriptor.explosivePower,
        destroysResistantBlocks: skull.descriptor.destroysResistantBlocks,
      })
    } else if (ageSecs < SKULL_MAX_AGE_SECS) {
      skulls.push({ ...skull, position, ageSecs })
    }
  }

  return Result.succeed({
    state: { ...runtime, nextSkullId, withers, skulls },
    explosions,
    meleeDamage,
  })
}

export const snapshotWitherRuntime = (runtime: WitherRuntimeState): WitherRuntimeSnapshot => ({
  nextWitherId: runtime.nextWitherId,
  nextSkullId: runtime.nextSkullId,
  withers: runtime.withers.map((wither) => ({
    id: wither.id,
    dimension: wither.dimension,
    snapshot: serializeWither(wither.state),
    rangedCooldownSecs: wither.rangedCooldownSecs,
    meleeCooldownSecs: wither.meleeCooldownSecs,
    shotsFired: wither.shotsFired,
  })),
  skulls: runtime.skulls,
})

export const restoreWitherRuntime = (
  snapshot: WitherRuntimeSnapshot | undefined,
): WitherRuntimeState => snapshot === undefined
  ? initialWitherRuntimeState()
  : {
      nextWitherId: snapshot.nextWitherId,
      nextSkullId: snapshot.nextSkullId,
      withers: snapshot.withers.map((wither) => ({
        id: wither.id,
        dimension: wither.dimension,
        state: restoreWither(wither.snapshot),
        rangedCooldownSecs: wither.rangedCooldownSecs,
        meleeCooldownSecs: wither.meleeCooldownSecs,
        shotsFired: wither.shotsFired,
      })),
      skulls: snapshot.skulls,
    }

export const witherRenderDescriptors = (
  runtime: WitherRuntimeState,
  dimension: string,
): ReadonlyArray<WitherRenderDescriptor> => [
  ...runtime.withers
    .filter((wither) => wither.dimension === dimension)
    .map((wither) => ({
      id: wither.id,
      kind: 'wither' as const,
      category: 'hostile' as const,
      feetPosition: wither.state.feetPosition,
    })),
  ...runtime.skulls
    .filter((skull) => skull.dimension === dimension)
    .map((skull) => ({
      id: skull.id,
      kind: 'wither_skull' as const,
      category: 'hostile' as const,
      feetPosition: skull.position,
      facingRadians: Math.atan2(-skull.descriptor.direction.x, -skull.descriptor.direction.z),
    })),
]
