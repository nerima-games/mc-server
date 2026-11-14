import { Brand, Result } from 'effect'
import { ITEM_TYPES, type ItemType } from '@nerima-games/mc-kernel'
import {
  ENCHANTMENT_IDS,
  ENCHANTMENT_REGISTRY,
  type EnchantedItem,
  type EnchantmentId,
} from '@nerima-games/mx-gameplay'
import {
  AnvilCustomName,
  AnvilEnchantmentId,
  ExperienceLevel,
  TotalExperience,
  enchantmentRuleFor,
  isAnvilCustomName,
  planAnvil,
  durabilityForItem,
  experienceCostOfLevel,
  itemStack,
  levelForTotalExperience,
  totalExperienceAtLevel,
  type AnvilCustomName as AnvilCustomNameValue,
  type AnvilDurability,
  type AnvilInputStack,
  type AnvilItemPayload,
  type AnvilPlan,
  type AnvilPrimitiveFailure,
  type AnvilRuleSet,
  type CanonicalAnvilItemPayload,
  type ItemStackFailure,
  type PlayerStorage,
} from '@nerima-games/mc-sim'

const isGameplayEnchantmentId = (value: string): value is EnchantmentId =>
  ENCHANTMENT_IDS.some((id) => id === value)

export type AnvilRuleConfigurationFailure = {
  readonly _tag: 'AnvilRuleConfigurationFailure'
  readonly enchantmentId: EnchantmentId
}

export type AnvilOperationFailure =
  | AnvilPrimitiveFailure
  | AnvilRuleConfigurationFailure
  | ItemStackFailure

const buildAnvilEnchantmentRule = (
  id: EnchantmentId,
): Result.Result<
  AnvilRuleSet['enchantments'][number],
  AnvilRuleConfigurationFailure | AnvilPrimitiveFailure
> => {
  const sourceRule = enchantmentRuleFor(id)
  if (sourceRule === undefined) {
    return Result.fail({ _tag: 'AnvilRuleConfigurationFailure', enchantmentId: id })
  }

  const definition = ENCHANTMENT_REGISTRY[id]
  return Result.map(Result.all(definition.incompatibleWith.map(AnvilEnchantmentId)), (incompatibleWith) => ({
    id: sourceRule.id,
    maxLevel: definition.maxLevel,
    applicableItems: sourceRule.applicableItems,
    incompatibleWith,
    costPerLevel: 1,
  }))
}

export const spendExperienceLevels = (
  totalExperience: number,
  levels: number,
): Result.Result<number | undefined, Brand.BrandError> => {
  const checkedExperience = TotalExperience.result(totalExperience)
  if (Result.isFailure(checkedExperience)) return Result.fail(checkedExperience.failure)
  const checkedLevels = ExperienceLevel.result(levels)
  if (Result.isFailure(checkedLevels)) return Result.fail(checkedLevels.failure)

  const currentLevel = levelForTotalExperience(checkedExperience.success)
  if (currentLevel < checkedLevels.success) return Result.succeed(undefined)
  if (levels === 0) return Result.succeed(checkedExperience.success)

  const progress = (
    checkedExperience.success - totalExperienceAtLevel(currentLevel)
  ) / experienceCostOfLevel(currentLevel)
  const nextLevel = ExperienceLevel.result(currentLevel - checkedLevels.success)
  if (Result.isFailure(nextLevel)) return Result.fail(nextLevel.failure)
  return Result.succeed(totalExperienceAtLevel(nextLevel.success)
    + Math.floor(progress * experienceCostOfLevel(nextLevel.success)))
}

export type AnvilOperationRequest = {
  readonly name: string
  readonly currentName?: string | null
  readonly enchantedItem?: EnchantedItem
}

export type AnvilOperationInput = AnvilOperationRequest & {
  readonly item: ItemType
  readonly durability: AnvilDurability | null
  readonly material?: {
    readonly item: ItemType
    readonly count: number
  }
}

export type AppliedAnvilOperation = {
  readonly storage: PlayerStorage
  readonly output: CanonicalAnvilItemPayload
  readonly levelCost: number
  readonly materialCost: number
}

const invalidInput = (path: string, reason: string): AnvilPlan => ({
  ok: false,
  reason: 'invalid-input',
  issues: [{ path, reason }],
})

const anvilRepairMaterials = ITEM_TYPES.flatMap((item) => {
  const durability = durabilityForItem(item)
  return durability === null
    ? []
    : [{ target: item, material: 'iron_ingot' as const, durabilityPerUnit: durability.max }]
})

export const ANVIL_RULES: Result.Result<
  AnvilRuleSet,
  AnvilRuleConfigurationFailure | AnvilPrimitiveFailure
> = Result.map(
  Result.all(ENCHANTMENT_IDS.map(buildAnvilEnchantmentRule)),
  (enchantments) => Object.freeze({
    enchantments: Object.freeze(enchantments),
    repairMaterials: Object.freeze(anvilRepairMaterials),
  }),
)

const anvilPayload = (
  item: ItemType,
  durability: AnvilDurability | null,
  enchantments: ReadonlyArray<{ readonly id: string; readonly level: number }>,
  customName: AnvilCustomNameValue | null,
): Result.Result<AnvilItemPayload, AnvilPrimitiveFailure> => Result.map(
  Result.all(enchantments.map((enchantment) =>
    Result.map(AnvilEnchantmentId(enchantment.id), (id) => ({ id, level: enchantment.level })),
  )),
  (convertedEnchantments) => ({
    item,
    durability,
    enchantments: convertedEnchantments,
    repairCost: 0,
    customName,
  }),
)

export const planAnvilOperation = (
  input: AnvilOperationInput,
): Result.Result<AnvilPlan, AnvilPrimitiveFailure | AnvilRuleConfigurationFailure> => {
  if (typeof input.name !== 'string') return Result.succeed(invalidInput('name', 'must be a string'))

  const requestedName = input.name.trim()
  if (requestedName !== '' && !isAnvilCustomName(requestedName)) {
    return Result.succeed(invalidInput('name', 'must be at most 50 characters without control characters'))
  }
  const existingName = input.currentName?.trim() ?? ''
  if (existingName !== '' && !isAnvilCustomName(existingName)) {
    return Result.succeed(invalidInput('currentName', 'must be at most 50 characters without control characters'))
  }

  const enchantedItem = input.enchantedItem
  if (enchantedItem !== undefined && enchantedItem.item !== input.item) {
    return Result.succeed(invalidInput('enchantedItem.item', 'must match item'))
  }

  const enchantments = enchantedItem?.enchantments ?? []
  for (const [index, enchantment] of enchantments.entries()) {
    if (!isGameplayEnchantmentId(enchantment.id)) {
      return Result.succeed(invalidInput(`enchantedItem.enchantments[${index}].id`, 'unsupported enchantment'))
    }
  }

  const material = input.material
  if (material !== undefined && (!Number.isSafeInteger(material.count) || material.count <= 0)) {
    return Result.succeed(invalidInput('material.count', 'must be a positive safe integer'))
  }

  const requestedNameResult: Result.Result<AnvilCustomNameValue | null, AnvilPrimitiveFailure> = requestedName === ''
    ? Result.succeed(null)
    : AnvilCustomName(requestedName)
  const existingNameResult: Result.Result<AnvilCustomNameValue | null, AnvilPrimitiveFailure> = existingName === ''
    ? Result.succeed(null)
    : AnvilCustomName(existingName)
  const left = Result.flatMap(
    existingNameResult,
    (customName) => anvilPayload(input.item, input.durability, enchantments, customName),
  )
  const right: Result.Result<AnvilInputStack | null, AnvilPrimitiveFailure> = material === undefined
    ? Result.succeed(null)
    : Result.map(anvilPayload(material.item, null, [], null), (payload) => ({
        payload,
        count: material.count,
      }))

  return Result.map(
    Result.all({ left, right, rename: requestedNameResult, rules: ANVIL_RULES }),
    ({ left: leftPayload, right: rightInput, rename, rules }) => planAnvil(
      {
        left: leftPayload,
        right: rightInput,
        rename,
        experienceLevels: 0,
      },
      rules,
    ),
  )
}

export const enchantedItemFromAnvilOutput = (
  output: CanonicalAnvilItemPayload,
): EnchantedItem | undefined => {
  if (output.enchantments.length === 0) return undefined
  const enchantments: Array<{ readonly id: EnchantmentId; readonly level: number }> = []
  for (const enchantment of output.enchantments) {
    const id = String(enchantment.id)
    if (!isGameplayEnchantmentId(id)) return undefined
    enchantments.push({ id, level: enchantment.level })
  }
  return {
    item: output.item,
    durability: output.durability,
    enchantments,
  }
}

export const applyAnvilOperation = (
  storage: PlayerStorage,
  slotIndex: number,
  request: AnvilOperationRequest,
): Result.Result<AppliedAnvilOperation | undefined, AnvilOperationFailure> => {
  const stack = storage.inventory.slots[slotIndex]
  if (stack === undefined) return Result.succeed(undefined)

  const durability = storage.inventoryDurability[slotIndex] ?? null
  const needsRepair = durability !== null && durability.current < durability.max
  const ironIndex = needsRepair
    ? storage.inventory.slots.findIndex(
        (candidate, index) => index !== slotIndex && candidate?.item === 'iron_ingot' && candidate.count > 0,
      )
    : -1
  const iron = ironIndex < 0 ? undefined : storage.inventory.slots[ironIndex]
  const operationInput = {
    ...request,
    item: stack.item,
    durability,
  }
  return Result.flatMap(planAnvilOperation(
    iron === undefined
      ? operationInput
      : { ...operationInput, material: { item: iron.item, count: iron.count } },
  ), (anvilPlan) => {
    if (!anvilPlan.ok || (anvilPlan.materialCost > 0 && iron === undefined)) {
      return Result.succeed(undefined)
    }

    const slots = [...storage.inventory.slots]
    const inventoryDurability = [...storage.inventoryDurability]
    const remainingStack = iron !== undefined && anvilPlan.materialCost > 0
      && Number(iron.count) !== Number(anvilPlan.materialCost)
      ? itemStack(iron.item, iron.count - anvilPlan.materialCost)
      : Result.succeed(undefined)

    return Result.map(remainingStack, (stackAfterConsumption) => {
      if (iron !== undefined && anvilPlan.materialCost > 0) {
        slots[ironIndex] = stackAfterConsumption
        if (Number(iron.count) === Number(anvilPlan.materialCost)) inventoryDurability[ironIndex] = null
      }
      inventoryDurability[slotIndex] = anvilPlan.output.durability

      return {
        storage: {
          ...storage,
          inventory: { slots },
          inventoryDurability,
        },
        output: anvilPlan.output,
        levelCost: anvilPlan.levelCost,
        materialCost: anvilPlan.materialCost,
      }
    })
  })
}
