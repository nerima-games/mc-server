import { AIR_BLOCK_ID, blockIdOf, CHUNK_SIZE_XZ, isBlockType, type BlockId } from '@nerima-games/mc-kernel'
import { blockIndex, CHUNK_VOLUME, type ChunkBiomeType, type ChunkSource } from '@nerima-games/mc-worldgen'
import { Effect, Option } from 'effect'

import { chunkSourceFromBlocks } from '../../apps/multiplayer-server/core'

const fixtureBlockId = (block: string): BlockId => {
  if (!isBlockType(block)) throw new Error(`fixture terrain names an unregistered block: ${block}`)
  return Option.getOrThrow(blockIdOf(block))
}

/** Fixture terrain: `blockAt` names the block at each position, or `null` for air. */
export const terrainFrom = (blockAt: (position: Readonly<{ x: number; y: number; z: number }>) => string | null): ChunkSource =>
  chunkSourceFromBlocks('PLAINS', (position) => {
    const block = blockAt(position)
    return block === null ? AIR_BLOCK_ID : fixtureBlockId(block)
  })

export const airTerrain: ChunkSource = terrainFrom(() => null)

/**
 * A `block` floor filling the layer `floorY` with `cells` placed over it: the same chunks `terrainFrom` builds, filled
 * per layer instead of per block, for fixtures that generate hundreds of chunks.
 */
export const floorTerrain = (
  floorY: number,
  block: string,
  cells: ReadonlyArray<Readonly<{ at: Readonly<{ x: number; y: number; z: number }>; block: string | null }>> = [],
): ChunkSource => {
  const floor = fixtureBlockId(block)
  const placed = cells.map(({ at, block: cell }) => ({ at, id: cell === null ? AIR_BLOCK_ID : fixtureBlockId(cell) }))
  return (coord) => Effect.sync(() => {
    const blocks = new Uint16Array(CHUNK_VOLUME).fill(AIR_BLOCK_ID)
    for (let lx = 0; lx < CHUNK_SIZE_XZ; lx += 1) {
      for (let lz = 0; lz < CHUNK_SIZE_XZ; lz += 1) blocks[blockIndex(lx, floorY, lz)] = floor
    }
    for (const { at, id } of placed) {
      const lx = at.x - coord.cx * CHUNK_SIZE_XZ
      const lz = at.z - coord.cz * CHUNK_SIZE_XZ
      if (lx >= 0 && lx < CHUNK_SIZE_XZ && lz >= 0 && lz < CHUNK_SIZE_XZ) blocks[blockIndex(lx, at.y, lz)] = id
    }
    const biomes: Array<ChunkBiomeType> = Array.from({ length: CHUNK_SIZE_XZ * CHUNK_SIZE_XZ }, () => 'PLAINS')
    return { coord, blocks, biomes }
  })
}
