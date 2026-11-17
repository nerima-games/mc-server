import { maxStackCountForItem, type BrewingState, type ItemStack, type ItemType } from '@nerima-games/mc-kernel'
import { BREWING_FUEL_ITEM, BREWING_MAX_FUEL_CHARGES, VANILLA_BREWING_RECIPES, addBrewingFuel, advanceBrewing, brewingState, emptyBrewingState, itemStack, setBrewingBottle, setBrewingIngredient, type BrewingFailure } from '@nerima-games/mc-sim'
import { type BrewingAction, brewingStateToWire, furnaceStateFromWire, type BrewingWireConversionFailure, type FurnaceWireConversionFailure, type StatusEffectState as StatusEffectsWire, type ActiveStatusEffect } from '@nerima-games/mx-multiplayer'
import { Result } from 'effect'
import { copyStatusEffectState, isValidStatusEffectState, type StatusEffectState } from '@nerima-games/mx-gameplay'
import { savedServerStateFailure, type SavedServerStateFailure } from './legacy-state.js'

export { advanceBrewing, emptyBrewingState, brewingStateToWire, furnaceStateFromWire, setBrewingBottle }
export type { BrewingState, BrewingWireConversionFailure, FurnaceWireConversionFailure }
export type { BrewingStandState as BrewingStandWire } from '@nerima-games/mx-multiplayer'
export type { BrewingCommand, BrewingCommandResult, BrewingMessage as BrewingWireMessage, BrewingRejectionReason } from '@nerima-games/mx-multiplayer'

export type BrewingOperationFailure = BrewingFailure | Readonly<{ _tag: 'BrewingInsertRejected' }>
const rejected = (): Result.Result<never, BrewingOperationFailure> => Result.fail({ _tag: 'BrewingInsertRejected' })
const supportedPotionOutput = (item: ItemType) => item === 'awkward_potion' || item === 'potion_of_swiftness' || item === 'potion_of_poison' || item === 'potion_of_regeneration'
// Restrict recipes to the potion outputs supported by mx-gameplay statusEffectOfPotion.
const supportedRecipes = VANILLA_BREWING_RECIPES.filter((recipe) => supportedPotionOutput(recipe.output))
const bottleItem = (item: string): item is ItemType => supportedRecipes.some((recipe) => recipe.input === item || recipe.output === item)
const ingredientItem = (item: string): item is ItemType => supportedRecipes.some((recipe) => recipe.ingredient === item)

export const insertBrewingItem = (
  state: BrewingState,
  action: Extract<BrewingAction, { _tag: 'insert-fuel' | 'insert-bottle' | 'insert-ingredient' }>,
  source: Readonly<{ item: string; count: number }>,
): Result.Result<BrewingState, BrewingOperationFailure> => {
  switch (action._tag) {
    case 'insert-bottle':
      if (!bottleItem(source.item) || state.bottles[action.bottleIndex] !== undefined) return rejected()
      return Result.flatMap(itemStack(source.item, 1), (bottle) => setBrewingBottle(state, action.bottleIndex, bottle))
    case 'insert-ingredient':
      if (!ingredientItem(source.item) || state.ingredient !== undefined) return rejected()
      return Result.flatMap(itemStack(source.item, 1), (ingredient) => setBrewingIngredient(state, ingredient))
    case 'insert-fuel': {
      if (source.item !== BREWING_FUEL_ITEM || state.fuelCharges === BREWING_MAX_FUEL_CHARGES || (state.fuel !== undefined && (state.fuel.item !== BREWING_FUEL_ITEM || state.fuel.count === maxStackCountForItem(BREWING_FUEL_ITEM)))) return rejected()
      const fuel = itemStack(BREWING_FUEL_ITEM, (state.fuel?.count ?? 0) + 1)
      return Result.flatMap(fuel, (stack) => Result.flatMap(brewingState({ ...state, fuel: stack }), addBrewingFuel))
    }
  }
}

export type StatusEffectsWireFailure = Readonly<{ _tag: 'UnsupportedVisibleStatusEffect'; type: StatusEffectState['effects'][number]['type'] }>

export const statusEffectsToWire = (state: StatusEffectState): Result.Result<StatusEffectsWire, StatusEffectsWireFailure> => {
  const effects: Array<ActiveStatusEffect> = []
  for (const effect of state.effects) {
    switch (effect.type) {
      case 'poison':
      case 'regeneration':
      case 'speed':
      case 'hunger':
      case 'nausea':
        effects.push({ type: effect.type, amplifier: effect.amplifier, remainingSecs: effect.remainingSecs, pulseClockSecs: effect.pulseClockSecs })
        break
      default:
        return Result.fail({ _tag: 'UnsupportedVisibleStatusEffect', type: effect.type })
    }
  }
  return Result.succeed({ effects })
}

export const validateServerStatusEffects = (value: unknown): Result.Result<StatusEffectState, SavedServerStateFailure> => {
  if (!isValidStatusEffectState(value)) return Result.fail(savedServerStateFailure('statusEffects', 'invalid status effect state'))
  const projected = statusEffectsToWire(value)
  if (Result.isFailure(projected)) return Result.fail(savedServerStateFailure('statusEffects', `unsupported visible status effect type: ${projected.failure.type}`))
  return Result.succeed(copyStatusEffectState(value))
}

export const brewingDrops = (state: BrewingState): ReadonlyArray<ItemStack> =>
  [...state.bottles, state.ingredient, state.fuel].filter((stack): stack is ItemStack => stack !== undefined)
