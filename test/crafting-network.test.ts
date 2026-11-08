import type { WireText } from '@nerima-games/mx-multiplayer'
import { describe, expect, it } from 'vitest'

import { decodeCraftingWireMessage } from '../apps/multiplayer-shared/crafting-network'

const wire = (value: unknown): WireText => JSON.stringify(value) as WireText

const command = {
  _tag: 'CraftingCommand',
  commandId: 'craft-1',
  player: 'alice',
  world: 'world-1',
  expectedRevision: 4,
  grid: { width: 2, height: 2, cells: ['oak_log', null, null, null] },
} as const

describe('crafting wire codec', () => {
  it('decodes a valid command', () => {
    expect(decodeCraftingWireMessage(wire(command))).toEqual(command)
  })

  it('accepts the alternate three-by-three grid size', () => {
    const threeByThree = { ...command, grid: { width: 3, height: 3, cells: Array(9).fill(null) } }

    expect(decodeCraftingWireMessage(wire(threeByThree))).toEqual(threeByThree)
    expect(decodeCraftingWireMessage(wire({
      ...threeByThree,
      grid: { ...threeByThree.grid, cells: ['oak_log', null, null, null, null, null, null, null, 'unknown-item'] },
    }))).toBeUndefined()
  })

  it.each([
    ['non-square grid', { ...command, grid: { width: 2, height: 3, cells: Array(6).fill(null) } }],
    ['wrong cell count', { ...command, grid: { width: 2, height: 2, cells: [null] } }],
    ['missing grid object', { ...command, grid: null }],
    ['non-array cells', { ...command, grid: { width: 2, height: 2, cells: {} } }],
    ['unknown item', { ...command, grid: { width: 2, height: 2, cells: ['not-an-item', null, null, null] } }],
    ['extra command field', { ...command, extra: true }],
  ])('rejects %s', (_case, message) => {
    expect(decodeCraftingWireMessage(wire(message))).toBeUndefined()
  })

  it('rejects client-declared output and item counts', () => {
    expect(decodeCraftingWireMessage(wire({ ...command, output: { item: 'oak_planks', count: 64 } }))).toBeUndefined()
    expect(decodeCraftingWireMessage(wire({
      ...command,
      grid: { width: 2, height: 2, cells: [{ item: 'oak_log', count: 64 }, null, null, null] },
    }))).toBeUndefined()
  })

  it('rejects non-object JSON payloads', () => {
    expect(decodeCraftingWireMessage(wire(null))).toBeUndefined()
  })

  it('decodes valid command results and rejects invalid identifiers or revisions', () => {
    expect(decodeCraftingWireMessage(wire({
      _tag: 'CraftingCommandResult', commandId: 'craft-1', accepted: true, revision: 5,
    }))).toEqual({ _tag: 'CraftingCommandResult', commandId: 'craft-1', accepted: true, revision: 5 })
    expect(decodeCraftingWireMessage(wire({
      _tag: 'CraftingCommandResult', commandId: 'craft-1', accepted: false, revision: 5, reason: 'no-match',
    }))).toEqual({ _tag: 'CraftingCommandResult', commandId: 'craft-1', accepted: false, revision: 5, reason: 'no-match' })
    expect(decodeCraftingWireMessage(wire({
      _tag: 'CraftingCommandResult', commandId: '', accepted: true, revision: 5,
    }))).toBeUndefined()
    expect(decodeCraftingWireMessage(wire({
      _tag: 'CraftingCommandResult', commandId: 'craft-1', accepted: true, revision: -1,
    }))).toBeUndefined()
  })

  it('rejects command results with an unknown reason', () => {
    expect(decodeCraftingWireMessage(wire({
      _tag: 'CraftingCommandResult', commandId: 'craft-1', accepted: false, revision: 5, reason: 'server-error',
    }))).toBeUndefined()
  })
})
