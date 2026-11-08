import { describe, expect, it } from 'vitest'
import {
  emptyPlayerStorage,
  itemStack,
  type PlayerStorage,
} from '@nerima-games/mc-sim'
import {
  applyAnvilOperation,
  enchantedItemFromAnvilOutput,
  planAnvilOperation,
  spendExperienceLevels,
} from '../apps/multiplayer-shared/anvil-repair'

const storageWith = (
  entries: ReadonlyArray<readonly [number, Parameters<typeof itemStack>[0], number, PlayerStorage['inventoryDurability'][number]]>,
): PlayerStorage => {
  const storage = emptyPlayerStorage()
  const slots = [...storage.inventory.slots]
  const inventoryDurability = [...storage.inventoryDurability]
  for (const [slotIndex, item, count, durability] of entries) {
    slots[slotIndex] = itemStack(item, count)
    inventoryDurability[slotIndex] = durability
  }
  return { ...storage, inventory: { slots }, inventoryDurability }
}

const planFromUnknown = (input: unknown): ReturnType<typeof planAnvilOperation> =>
  planAnvilOperation(input as Parameters<typeof planAnvilOperation>[0])

describe('planAnvilOperation', () => {
  it('uses the kernel repair plan and reports its material and level costs', () => {
    const plan = planAnvilOperation({
      item: 'diamond_pickaxe',
      durability: { current: 17, max: 1561 },
      material: { item: 'iron_ingot', count: 2 },
      name: '',
      currentName: null,
    })

    expect(plan).toMatchObject({ ok: true, levelCost: 1, materialCost: 1 })
    if (!plan.ok) return
    expect(plan.output.durability).toEqual({ current: 1561, max: 1561 })
  })

  it('supports rename-only operations without a repair material', () => {
    const plan = planAnvilOperation({
      item: 'stone',
      durability: null,
      name: 'Polished Stone',
      currentName: null,
    })

    expect(plan).toMatchObject({ ok: true, levelCost: 1, materialCost: 0 })
    if (!plan.ok) return
    expect(String(plan.output.customName)).toBe('Polished Stone')
    expect(enchantedItemFromAnvilOutput(plan.output)).toBeUndefined()
  })

  it('preserves valid enchantments when planning and converting output', () => {
    const enchantedItem = {
      item: 'iron_boots',
      durability: { current: 190, max: 195 },
      enchantments: [{ id: 'protection', level: 2 }],
    } as const
    const plan = planAnvilOperation({
      item: 'iron_boots',
      durability: enchantedItem.durability,
      name: 'Guard',
      currentName: null,
      enchantedItem,
    })

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(enchantedItemFromAnvilOutput(plan.output)).toEqual({
      item: 'iron_boots',
      durability: { current: 190, max: 195 },
      enchantments: [{ id: 'protection', level: 2 }],
    })
  })

  it('rejects an unsupported enchantment in a malformed canonical payload', () => {
    const malformedOutput = {
      item: 'iron_boots',
      durability: null,
      enchantments: [{ id: 'not-supported', level: 1 }],
    } as unknown as Parameters<typeof enchantedItemFromAnvilOutput>[0]

    expect(enchantedItemFromAnvilOutput(malformedOutput)).toBeUndefined()
  })

  it('returns typed invalid-input issues for malformed requests', () => {
    const base = { item: 'stone', durability: null, name: '' }
    const cases: ReadonlyArray<readonly [string, unknown, string, string]> = [
      ['non-string name', { ...base, name: 1 }, 'name', 'must be a string'],
      ['overlong name', { ...base, name: 'x'.repeat(51) }, 'name', 'must be at most 50 characters without control characters'],
      ['name with a control character', { ...base, name: 'new\nname' }, 'name', 'must be at most 50 characters without control characters'],
      ['overlong current name', { ...base, currentName: 'x'.repeat(51) }, 'currentName', 'must be at most 50 characters without control characters'],
      ['mismatched enchanted item', { ...base, enchantedItem: { item: 'iron_boots', durability: null, enchantments: [] } }, 'enchantedItem.item', 'must match item'],
      ['unsupported enchantment', { ...base, enchantedItem: { item: 'stone', durability: null, enchantments: [{ id: 'not-supported', level: 1 }] } }, 'enchantedItem.enchantments[0].id', 'unsupported enchantment'],
      ['zero material count', { ...base, material: { item: 'iron_ingot', count: 0 } }, 'material.count', 'must be a positive safe integer'],
      ['fractional material count', { ...base, material: { item: 'iron_ingot', count: 1.5 } }, 'material.count', 'must be a positive safe integer'],
    ]

    for (const [caseName, input, path, reason] of cases) {
      expect(planFromUnknown(input), caseName).toMatchObject({
        ok: false,
        reason: 'invalid-input',
        issues: [{ path, reason }],
      })
    }
  })

  it('replaces an existing custom name', () => {
    const plan = planAnvilOperation({
      item: 'stone',
      durability: null,
      name: 'New Name',
      currentName: 'Old Name',
    })

    expect(plan).toMatchObject({ ok: true })
    if (!plan.ok) return
    expect(String(plan.output.customName)).toBe('New Name')
  })
})

describe('applyAnvilOperation', () => {
  it('consumes one iron and restores the selected item to its catalog maximum', () => {
    const storage = storageWith([
      [3, 'diamond_pickaxe', 1, { current: 17, max: 1561 }],
      [8, 'iron_ingot', 2, null],
    ])

    const repaired = applyAnvilOperation(storage, 3, { name: '', currentName: null })

    expect(repaired?.storage.inventory.slots[8]).toEqual(itemStack('iron_ingot', 1))
    expect(repaired?.storage.inventoryDurability[3]).toEqual({ current: 1561, max: 1561 })
    expect(storage.inventoryDurability[3]).toEqual({ current: 17, max: 1561 })
  })

  it('clears the durability entry when repair consumes the full iron stack', () => {
    const storage = storageWith([
      [3, 'diamond_pickaxe', 1, { current: 17, max: 1561 }],
      [8, 'iron_ingot', 1, null],
    ])

    const repaired = applyAnvilOperation(storage, 3, { name: '', currentName: null })

    expect(repaired?.storage.inventory.slots[8]).toBeUndefined()
    expect(repaired?.storage.inventoryDurability[8]).toBeNull()
    expect(repaired?.storage.inventoryDurability[3]).toEqual({ current: 1561, max: 1561 })
  })

  it('supports renaming a non-damageable item without consuming repair material', () => {
    const storage = storageWith([
      [0, 'stone', 1, null],
      [1, 'iron_ingot', 1, null],
    ])

    const result = applyAnvilOperation(storage, 0, { name: 'Polished Stone', currentName: null })

    expect(result?.storage.inventory.slots[0]).toEqual(itemStack('stone', 1))
    expect(String(result?.output.customName)).toBe('Polished Stone')
    expect(result?.storage.inventory.slots[1]).toEqual(itemStack('iron_ingot', 1))
  })

  it('does not consume the selected iron stack when renaming it', () => {
    const onlyIron = storageWith([[0, 'iron_ingot', 2, null]])

    expect(
      applyAnvilOperation(onlyIron, 0, { name: 'Named Iron', currentName: null })
        ?.storage.inventory.slots[0],
    ).toEqual(itemStack('iron_ingot', 2))
  })

  it('rejects missing inputs without changing storage', () => {
    const empty = emptyPlayerStorage()
    const noIron = storageWith([[0, 'iron_sword', 1, { current: 10, max: 250 }]])

    expect(applyAnvilOperation(empty, 0, { name: 'New Name', currentName: null })).toBeUndefined()
    expect(applyAnvilOperation(noIron, 0, { name: '', currentName: null })).toBeUndefined()
    expect(noIron.inventoryDurability[0]).toEqual({ current: 10, max: 250 })
  })

  it('does not consume iron when repair and rename are both no-ops', () => {
    const storage = storageWith([
      [0, 'stone', 1, null],
      [1, 'iron_ingot', 1, null],
    ])

    expect(applyAnvilOperation(storage, 0, { name: '', currentName: null })).toBeUndefined()
    expect(storage.inventory.slots[1]).toEqual(itemStack('iron_ingot', 1))
  })
})

describe('spendExperienceLevels', () => {
  it('spends one level while retaining progress within the level', () => {
    expect(spendExperienceLevels(11, 1)).toBe(3)
  })

  it('spends exactly the boundary level and floors at level zero', () => {
    expect(spendExperienceLevels(7, 1)).toBe(0)
  })

  it('returns the current total when the cost is zero levels', () => {
    expect(spendExperienceLevels(11, 0)).toBe(11)
  })

  it('rejects a cost above the current level', () => {
    expect(spendExperienceLevels(6, 1)).toBeUndefined()
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    'rejects invalid total experience %s',
    (totalExperience) => {
      expect(spendExperienceLevels(totalExperience, 1)).toBeUndefined()
    },
  )

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0.5])(
    'rejects invalid level cost %s',
    (levels) => {
      expect(spendExperienceLevels(7, levels)).toBeUndefined()
    },
  )
})
