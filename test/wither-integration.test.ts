import { Result } from 'effect'
import { describe, expect, it } from 'vitest'
import { blockIdOf, blockTypeOfId } from '@nerima-games/mc-kernel'
import { isPlaceableItem } from '@nerima-games/mx-gameplay'

import {
  advanceWitherRuntime,
  damageRuntimeWither,
  initialWitherRuntimeState,
  matchRuntimeWitherSummon,
  summonRuntimeWither,
  witherRenderDescriptors,
} from '../apps/multiplayer-shared/wither-runtime'

const valueOf = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

describe('wither gameplay integration', () => {
  it('exposes wither structure blocks through the host placement vocabulary', () => {
    expect(isPlaceableItem('wither_skeleton_skull')).toBe(true)
    expect(blockTypeOfId(blockIdOf('wither_skeleton_skull'))).toBe('wither_skeleton_skull')
    expect(blockTypeOfId(blockIdOf('soul_soil'))).toBe('soul_soil')
  })

  it('consumes a completed structure, activates the wither, and produces its death drop', () => {
    const blocks = new Map([
      ['4,40,8', 'soul_sand'],
      ['4,41,8', 'soul_sand'],
      ['3,41,8', 'soul_soil'],
      ['5,41,8', 'soul_sand'],
      ['3,42,8', 'wither_skeleton_skull'],
      ['4,42,8', 'wither_skeleton_skull'],
      ['5,42,8', 'wither_skeleton_skull'],
    ])
    const match = valueOf(matchRuntimeWitherSummon(
      { x: 5, y: 42, z: 8 },
      ({ x, y, z }) => blocks.get(`${String(x)},${String(y)},${String(z)}`),
    ))
    expect(match).toBeDefined()
    for (const position of match?.consumedBlocks ?? []) {
      blocks.delete(`${String(position.x)},${String(position.y)},${String(position.z)}`)
    }
    expect(blocks).toHaveLength(0)

    let runtime = valueOf(summonRuntimeWither(
      initialWitherRuntimeState(),
      'overworld',
      match?.spawnPosition ?? { x: 4.5, y: 40, z: 8.5 },
    ))
    const activated = valueOf(advanceWitherRuntime(
      runtime,
      'overworld',
      { x: 14, y: 40, z: 8 },
      10,
      () => false,
    ))
    expect(activated.explosions).toContainEqual(expect.objectContaining({ power: 7 }))
    expect(witherRenderDescriptors(activated.state, 'overworld')).toContainEqual(expect.objectContaining({
      id: 'wither-1', kind: 'wither', category: 'hostile',
    }))

    runtime = activated.state
    const killed = valueOf(damageRuntimeWither(runtime, 'wither-1', 300, 'melee'))
    expect(killed.state.withers).toHaveLength(0)
    expect(killed.death?.drop).toEqual(expect.objectContaining({ item: 'nether_star', count: 1 }))
    expect(witherRenderDescriptors(killed.state, 'overworld')).toEqual([])
  })
})
