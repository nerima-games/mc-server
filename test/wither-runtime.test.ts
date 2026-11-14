import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  advanceWitherRuntime,
  damageRuntimeWither,
  initialWitherRuntimeState,
  isValidWitherRuntimeSnapshot,
  matchRuntimeWitherSummon,
  restoreWitherRuntime,
  snapshotWitherRuntime,
  summonRuntimeWither,
  witherRenderDescriptors,
} from '../apps/multiplayer-shared/wither-runtime'

const valueOf = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const isValidPosition = (position: Readonly<{ x: number; y: number; z: number }>): boolean =>
  Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z)

const isValidRuntimeState = (runtime: Parameters<typeof snapshotWitherRuntime>[0]): boolean =>
  isValidWitherRuntimeSnapshot(snapshotWitherRuntime(runtime))

const numericInput = fc.oneof(
  fc.double(),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
)

describe('wither runtime', () => {
  it('matches either horizontal summon orientation from the placed skull', () => {
    const materials = new Map([
      ['0,64,0', 'soul_sand'],
      ['0,65,0', 'soul_sand'],
      ['-1,65,0', 'soul_soil'],
      ['1,65,0', 'soul_sand'],
      ['-1,66,0', 'wither_skeleton_skull'],
      ['0,66,0', 'wither_skeleton_skull'],
      ['1,66,0', 'wither_skeleton_skull'],
    ])
    const match = valueOf(matchRuntimeWitherSummon(
      { x: 1, y: 66, z: 0 },
      ({ x, y, z }) => materials.get(`${String(x)},${String(y)},${String(z)}`),
    ))
    expect(match?.axis).toBe('x')
    expect(match?.consumedBlocks).toHaveLength(7)
    expect(valueOf(matchRuntimeWitherSummon(
      { x: 0, y: 66, z: 0 },
      () => undefined,
    ))).toBeUndefined()
  })

  it('charges for ten seconds, explodes, tracks, attacks, and persists', () => {
    let runtime = valueOf(summonRuntimeWither(initialWitherRuntimeState(), 'overworld', { x: 0, y: 64, z: 0 }))
    const charging = valueOf(advanceWitherRuntime(runtime, 'overworld', { x: 8, y: 64, z: 0 }, 9.9, () => false))
    expect(charging.explosions).toEqual([])

    const active = valueOf(advanceWitherRuntime(charging.state, 'overworld', { x: 8, y: 64, z: 0 }, 0.1, () => false))
    expect(active.explosions).toContainEqual(expect.objectContaining({ power: 7 }))
    expect(active.state.withers[0]?.state.phase).toBe('airborne')

    runtime = valueOf(advanceWitherRuntime(active.state, 'overworld', { x: 8, y: 64, z: 0 }, 2, () => false)).state
    expect(runtime.skulls).toHaveLength(1)
    const persisted = snapshotWitherRuntime(runtime)
    expect(isValidWitherRuntimeSnapshot(persisted)).toBe(true)
    expect(restoreWitherRuntime(persisted)).toEqual(runtime)
    expect(isValidWitherRuntimeSnapshot({
      ...persisted,
      skulls: [{ ...persisted.skulls[0]!, descriptor: { ...persisted.skulls[0]!.descriptor, variant: 'green' } }],
    })).toBe(false)
    expect(restoreWitherRuntime(undefined)).toEqual(initialWitherRuntimeState())
  })

  it('rejects malformed persisted runtime snapshots', () => {
    const runtime = valueOf(summonRuntimeWither(initialWitherRuntimeState(), 'overworld', { x: 0, y: 64, z: 0 }))
    const snapshot = snapshotWitherRuntime(runtime)

    expect(isValidWitherRuntimeSnapshot(snapshot)).toBe(true)
    expect(isValidWitherRuntimeSnapshot({ ...snapshot, nextWitherId: -1 })).toBe(false)
    expect(isValidWitherRuntimeSnapshot({
      ...snapshot,
      withers: [{ ...snapshot.withers[0]!, shotsFired: -1 }],
    })).toBe(false)
    expect(isValidWitherRuntimeSnapshot({
      ...snapshot,
      withers: [{ ...snapshot.withers[0]!, snapshot: { ...snapshot.withers[0]!.snapshot, state: { ...snapshot.withers[0]!.snapshot.state, phase: 'hovering' } } }],
    })).toBe(false)
  })

  it('ignores ranged damage after armour activates and drops a nether star on death', () => {
    let runtime = valueOf(summonRuntimeWither(initialWitherRuntimeState(), 'overworld', { x: 0, y: 64, z: 0 }))
    runtime = valueOf(advanceWitherRuntime(runtime, 'overworld', { x: 10, y: 64, z: 0 }, 10, () => false)).state
    expect(valueOf(damageRuntimeWither(runtime, 'missing-wither', 10, 'melee'))).toEqual({ state: runtime, death: undefined })
    runtime = valueOf(damageRuntimeWither(runtime, 'wither-1', 150, 'melee')).state
    expect(runtime.withers[0]?.state.phase).toBe('armoured')
    const ranged = valueOf(damageRuntimeWither(runtime, 'wither-1', 100, 'ranged'))
    expect(ranged.state.withers[0]?.state.healthPoints).toBe(150)
    const killed = valueOf(damageRuntimeWither(ranged.state, 'wither-1', 150, 'melee'))
    expect(killed.death?.drop).toEqual({
      item: 'nether_star',
      count: 1,
      position: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number), z: expect.any(Number) }),
    })
    expect(killed.state.withers).toEqual([])
  })

  it('uses blue skull terrain semantics every third shot', () => {
    let runtime = valueOf(summonRuntimeWither(initialWitherRuntimeState(), 'overworld', { x: 0, y: 64, z: 0 }))
    runtime = valueOf(advanceWitherRuntime(runtime, 'overworld', { x: 20, y: 64, z: 0 }, 10, () => false)).state
    for (let shot = 0; shot < 3; shot += 1) {
      runtime = valueOf(advanceWitherRuntime(runtime, 'overworld', { x: 20, y: 64, z: 0 }, 2, () => false)).state
    }
    expect(runtime.withers[0]?.shotsFired).toBe(3)
    expect(runtime.skulls.map((skull) => skull.descriptor.variant)).toEqual(['normal', 'normal', 'blue'])
    expect(runtime.skulls.find((skull) => skull.descriptor.variant === 'blue')?.descriptor.destroysResistantBlocks).toBe(true)
  })

  it('keeps withers and skulls within their dimensions and resolves projectile collisions', () => {
    let runtime = valueOf(summonRuntimeWither(initialWitherRuntimeState(), 'overworld', { x: 0, y: 64, z: 0 }))
    runtime = valueOf(summonRuntimeWither(runtime, 'nether', { x: 20, y: 64, z: 0 }))
    const charged = valueOf(advanceWitherRuntime(runtime, 'overworld', { x: 8, y: 64, z: 0 }, 10, () => false))
    const fired = valueOf(advanceWitherRuntime(charged.state, 'overworld', { x: 8, y: 64, z: 0 }, 2, () => false))
    expect(fired.state.skulls).toHaveLength(1)
    expect(isValidWitherRuntimeSnapshot(snapshotWitherRuntime(fired.state))).toBe(true)
    expect(witherRenderDescriptors(fired.state, 'overworld').map((descriptor) => descriptor.kind)).toEqual(['wither', 'wither_skull'])

    const netherStep = valueOf(advanceWitherRuntime(fired.state, 'nether', { x: 30, y: 64, z: 0 }, 1, () => false))
    expect(netherStep.state.skulls).toEqual(fired.state.skulls)
    expect(netherStep.state.withers.find((wither) => wither.dimension === 'overworld')).toEqual(
      fired.state.withers.find((wither) => wither.dimension === 'overworld'),
    )
    expect(witherRenderDescriptors(netherStep.state, 'nether').map((descriptor) => descriptor.kind)).toEqual(['wither'])

    const withoutShooter = valueOf(damageRuntimeWither(netherStep.state, 'wither-1', 300, 'melee')).state
    const skull = withoutShooter.skulls[0]!
    const hitPlayer = valueOf(advanceWitherRuntime(
      withoutShooter,
      'overworld',
      { x: skull.position.x, y: skull.position.y - 0.9, z: skull.position.z },
      0,
      () => false,
    ))
    expect(hitPlayer.explosions).toHaveLength(1)
    expect(hitPlayer.state.skulls).toHaveLength(0)

    const hitWorld = valueOf(advanceWitherRuntime(withoutShooter, 'overworld', { x: 100, y: 64, z: 0 }, 0, () => true))
    expect(hitWorld.explosions).toHaveLength(1)
    const expired = valueOf(advanceWitherRuntime(withoutShooter, 'overworld', { x: 100, y: 64, z: 0 }, 10, () => false))
    expect(expired.state.skulls).toHaveLength(0)
  })

  it('returns typed failures or valid results for arbitrary brand inputs', () => {
    const runtime = valueOf(summonRuntimeWither(initialWitherRuntimeState(), 'overworld', { x: 0, y: 64, z: 0 }))
    fc.assert(fc.property(
      fc.record({ x: numericInput, y: numericInput, z: numericInput, amount: numericInput, deltaSecs: numericInput }),
      ({ x, y, z, amount, deltaSecs }) => {
        const position = { x, y, z }
        const summoned = summonRuntimeWither(initialWitherRuntimeState(), 'overworld', position)
        const matched = matchRuntimeWitherSummon(position, () => undefined)
        const damaged = damageRuntimeWither(runtime, 'wither-1', amount, 'melee')
        const advanced = advanceWitherRuntime(runtime, 'overworld', position, deltaSecs, () => false)

        return (Result.isFailure(summoned)
          || (isValidPosition(position) && isValidRuntimeState(summoned.success)))
          && (Result.isFailure(matched)
            || (isValidPosition(position) && matched.success === undefined))
          && (Result.isFailure(damaged)
            || (Number.isFinite(amount) && amount >= 0 && isValidRuntimeState(damaged.success.state)))
          && (Result.isFailure(advanced)
            || (isValidPosition(position)
              && Number.isFinite(deltaSecs)
              && deltaSecs >= 0
              && isValidRuntimeState(advanced.success.state)
              && Number.isFinite(advanced.success.meleeDamage)
              && advanced.success.explosions.every((explosion) =>
                isValidPosition(explosion.position) && Number.isFinite(explosion.power))))
      },
    ))
  })

  it('rejects invalid values just outside numeric boundaries', () => {
    const initial = initialWitherRuntimeState()
    const runtime = valueOf(summonRuntimeWither(initial, 'overworld', { x: 0, y: 64, z: 0 }))
    const target = { x: 8, y: 64, z: 0 }

    expect(isValidRuntimeState(valueOf(summonRuntimeWither(initial, 'overworld', { x: 0, y: 64, z: 0 })))).toBe(true)
    expect(Result.isFailure(summonRuntimeWither(initial, 'overworld', { x: Number.NaN, y: 64, z: 0 }))).toBe(true)
    expect(Result.isFailure(summonRuntimeWither(initial, 'overworld', { x: Number.POSITIVE_INFINITY, y: 64, z: 0 }))).toBe(true)
    expect(Result.isFailure(matchRuntimeWitherSummon({ x: Number.NaN, y: 66, z: 0 }, () => undefined))).toBe(true)
    expect(Result.isFailure(matchRuntimeWitherSummon({ x: Number.POSITIVE_INFINITY, y: 66, z: 0 }, () => undefined))).toBe(true)

    expect(valueOf(damageRuntimeWither(runtime, 'wither-1', 0, 'melee')).state).toEqual(runtime)
    expect(Result.isFailure(damageRuntimeWither(runtime, 'wither-1', -Number.MIN_VALUE, 'melee'))).toBe(true)
    expect(Result.isFailure(damageRuntimeWither(runtime, 'wither-1', Number.NaN, 'melee'))).toBe(true)

    expect(valueOf(advanceWitherRuntime(runtime, 'overworld', target, 0, () => false)).state).toEqual(runtime)
    expect(Result.isFailure(advanceWitherRuntime(runtime, 'overworld', target, -Number.MIN_VALUE, () => false))).toBe(true)
    for (const deltaSecs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(Result.isFailure(advanceWitherRuntime(runtime, 'overworld', target, deltaSecs, () => false))).toBe(true)
    }
  })
})
