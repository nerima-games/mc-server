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
    const match = matchRuntimeWitherSummon(
      { x: 1, y: 66, z: 0 },
      ({ x, y, z }) => materials.get(`${String(x)},${String(y)},${String(z)}`),
    )
    expect(match?.axis).toBe('x')
    expect(match?.consumedBlocks).toHaveLength(7)
    expect(matchRuntimeWitherSummon(
      { x: 0, y: 66, z: 0 },
      () => undefined,
    )).toBeUndefined()
  })

  it('charges for ten seconds, explodes, tracks, attacks, and persists', () => {
    let runtime = summonRuntimeWither(initialWitherRuntimeState(), 'overworld', { x: 0, y: 64, z: 0 })
    const charging = advanceWitherRuntime(runtime, 'overworld', { x: 8, y: 64, z: 0 }, 9.9, () => false)
    expect(charging.explosions).toEqual([])

    const active = advanceWitherRuntime(charging.state, 'overworld', { x: 8, y: 64, z: 0 }, 0.1, () => false)
    expect(active.explosions).toContainEqual(expect.objectContaining({ power: 7 }))
    expect(active.state.withers[0]?.state.phase).toBe('airborne')

    runtime = advanceWitherRuntime(active.state, 'overworld', { x: 8, y: 64, z: 0 }, 2, () => false).state
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
    const runtime = summonRuntimeWither(initialWitherRuntimeState(), 'overworld', { x: 0, y: 64, z: 0 })
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
    let runtime = summonRuntimeWither(initialWitherRuntimeState(), 'overworld', { x: 0, y: 64, z: 0 })
    runtime = advanceWitherRuntime(runtime, 'overworld', { x: 10, y: 64, z: 0 }, 10, () => false).state
    expect(damageRuntimeWither(runtime, 'missing-wither', 10, 'melee')).toEqual({ state: runtime, death: undefined })
    runtime = damageRuntimeWither(runtime, 'wither-1', 150, 'melee').state
    expect(runtime.withers[0]?.state.phase).toBe('armoured')
    const ranged = damageRuntimeWither(runtime, 'wither-1', 100, 'ranged')
    expect(ranged.state.withers[0]?.state.healthPoints).toBe(150)
    const killed = damageRuntimeWither(ranged.state, 'wither-1', 150, 'melee')
    expect(killed.death?.drop).toEqual({
      item: 'nether_star',
      count: 1,
      position: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number), z: expect.any(Number) }),
    })
    expect(killed.state.withers).toEqual([])
  })

  it('uses blue skull terrain semantics every third shot', () => {
    let runtime = summonRuntimeWither(initialWitherRuntimeState(), 'overworld', { x: 0, y: 64, z: 0 })
    runtime = advanceWitherRuntime(runtime, 'overworld', { x: 20, y: 64, z: 0 }, 10, () => false).state
    for (let shot = 0; shot < 3; shot += 1) {
      runtime = advanceWitherRuntime(runtime, 'overworld', { x: 20, y: 64, z: 0 }, 2, () => false).state
    }
    expect(runtime.withers[0]?.shotsFired).toBe(3)
    expect(runtime.skulls.map((skull) => skull.descriptor.variant)).toEqual(['normal', 'normal', 'blue'])
    expect(runtime.skulls.find((skull) => skull.descriptor.variant === 'blue')?.descriptor.destroysResistantBlocks).toBe(true)
  })

  it('keeps withers and skulls within their dimensions and resolves projectile collisions', () => {
    let runtime = summonRuntimeWither(initialWitherRuntimeState(), 'overworld', { x: 0, y: 64, z: 0 })
    runtime = summonRuntimeWither(runtime, 'nether', { x: 20, y: 64, z: 0 })
    const charged = advanceWitherRuntime(runtime, 'overworld', { x: 8, y: 64, z: 0 }, 10, () => false)
    const fired = advanceWitherRuntime(charged.state, 'overworld', { x: 8, y: 64, z: 0 }, 2, () => false)
    expect(fired.state.skulls).toHaveLength(1)
    expect(isValidWitherRuntimeSnapshot(snapshotWitherRuntime(fired.state))).toBe(true)
    expect(witherRenderDescriptors(fired.state, 'overworld').map((descriptor) => descriptor.kind)).toEqual(['wither', 'wither_skull'])

    const netherStep = advanceWitherRuntime(fired.state, 'nether', { x: 30, y: 64, z: 0 }, 1, () => false)
    expect(netherStep.state.skulls).toEqual(fired.state.skulls)
    expect(netherStep.state.withers.find((wither) => wither.dimension === 'overworld')).toEqual(
      fired.state.withers.find((wither) => wither.dimension === 'overworld'),
    )
    expect(witherRenderDescriptors(netherStep.state, 'nether').map((descriptor) => descriptor.kind)).toEqual(['wither'])

    const withoutShooter = damageRuntimeWither(netherStep.state, 'wither-1', 300, 'melee').state
    const skull = withoutShooter.skulls[0]!
    const hitPlayer = advanceWitherRuntime(
      withoutShooter,
      'overworld',
      { x: skull.position.x, y: skull.position.y - 0.9, z: skull.position.z },
      0,
      () => false,
    )
    expect(hitPlayer.explosions).toHaveLength(1)
    expect(hitPlayer.state.skulls).toHaveLength(0)

    const hitWorld = advanceWitherRuntime(withoutShooter, 'overworld', { x: 100, y: 64, z: 0 }, 0, () => true)
    expect(hitWorld.explosions).toHaveLength(1)
    const expired = advanceWitherRuntime(withoutShooter, 'overworld', { x: 100, y: 64, z: 0 }, 10, () => false)
    expect(expired.state.skulls).toHaveLength(0)
  })

  it('treats a non-finite frame duration as no elapsed time', () => {
    const runtime = summonRuntimeWither(initialWitherRuntimeState(), 'overworld', { x: 0, y: 64, z: 0 })
    const result = advanceWitherRuntime(runtime, 'overworld', { x: 8, y: 64, z: 0 }, Number.NaN, () => false)

    expect(result.state.withers[0]?.state.chargeRemainingSecs).toBe(10)
    expect(result.state.nextSkullId).toBe(0)
    expect(result.explosions).toEqual([])
  })
})
