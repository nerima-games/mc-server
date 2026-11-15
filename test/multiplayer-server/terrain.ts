import { AIR_BLOCK_ID, blockIdOf, isBlockType } from '@nerima-games/mc-kernel'
import type { ChunkSource } from '@nerima-games/mc-worldgen'
import { Option } from 'effect'

import { chunkSourceFromBlocks } from '../../apps/multiplayer-server/core'

/** Fixture terrain: `blockAt` names the block at each position, or `null` for air. */
export const terrainFrom = (blockAt: (position: Readonly<{ x: number; y: number; z: number }>) => string | null): ChunkSource =>
  chunkSourceFromBlocks('PLAINS', (position) => {
    const block = blockAt(position)
    if (block === null) return AIR_BLOCK_ID
    if (!isBlockType(block)) throw new Error(`fixture terrain names an unregistered block: ${block}`)
    return Option.getOrThrow(blockIdOf(block))
  })

export const airTerrain: ChunkSource = terrainFrom(() => null)
