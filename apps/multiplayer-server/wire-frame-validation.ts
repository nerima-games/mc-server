import type { WireText } from '@nerima-games/mx-multiplayer'
import { ANVIL_MAX_WIRE_LENGTH } from '../multiplayer-shared/anvil-network.js'
import { BREWING_MAX_WIRE_LENGTH } from '../multiplayer-shared/brewing-network.js'
import { CRAFTING_MAX_WIRE_LENGTH } from '../multiplayer-shared/crafting-network.js'
import { ENCHANTING_MAX_WIRE_LENGTH } from '../multiplayer-shared/enchanting-network.js'
import { ENDER_DRAGON_MAX_WIRE_LENGTH } from '../multiplayer-shared/ender-dragon-network.js'
import { PLAYER_DAMAGE_MAX_WIRE_LENGTH } from '../multiplayer-shared/player-damage-network.js'
import { SLEEP_MAX_WIRE_LENGTH } from '../multiplayer-shared/sleep-network.js'
import { WITHER_MAX_WIRE_LENGTH } from '../multiplayer-shared/wither-network.js'

export type UnknownRecord = Readonly<Record<string, unknown>>

export const unknownRecord = (value: unknown): UnknownRecord | undefined =>
  typeof value === 'object' && value !== null ? value as UnknownRecord : undefined

export const specializedFrameWireLengths: ReadonlyMap<string, number> = new Map([
  ['PlayerDamageCommand', PLAYER_DAMAGE_MAX_WIRE_LENGTH],
  ['CraftingCommand', CRAFTING_MAX_WIRE_LENGTH],
  ['BrewingCommand', BREWING_MAX_WIRE_LENGTH],
  ['AnvilCommand', ANVIL_MAX_WIRE_LENGTH],
  ['EnchantingCommand', ENCHANTING_MAX_WIRE_LENGTH],
  ['WitherCommand', WITHER_MAX_WIRE_LENGTH],
  ['EnderDragonCommand', ENDER_DRAGON_MAX_WIRE_LENGTH],
  ['SleepCommand', SLEEP_MAX_WIRE_LENGTH],
])

export const frameTag = (frame: WireText): string | undefined => {
  try {
    const record = unknownRecord(JSON.parse(frame))
    const tag = record?.['_tag']
    return typeof tag === 'string' ? tag : undefined
  } catch {
    return undefined
  }
}
