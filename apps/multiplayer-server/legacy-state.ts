import type { BrewingState } from '@nerima-games/mc-kernel'
import { brewingStateFromWire } from '@nerima-games/mx-multiplayer'
import { Result, Schema } from 'effect'

export type SavedServerStateFailure = {
  readonly _tag: 'SavedServerStateFailure'
  readonly path: string
  readonly reason: string
}

export const savedServerStateFailure = (path: string, reason: string): SavedServerStateFailure => ({
  _tag: 'SavedServerStateFailure', path, reason,
})

const potion = Schema.Literals(['awkward', 'speed', 'poison', 'regeneration'])
const ingredient = Schema.Literals(['nether_wart', 'sugar', 'spider_eye', 'ghast_tear'])
const legacyBrewing = Schema.Struct({
  fuelUnits: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  bottle: Schema.optionalKey(Schema.Union([Schema.Literal('water_bottle'), Schema.Struct({ potion })])),
  ingredient: Schema.optionalKey(ingredient),
  brewing: Schema.optionalKey(Schema.Struct({
    output: potion,
    remainingSecs: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  })),
})
const legacyFurnace = Schema.Struct({
  furnaceId: Schema.String,
  input: Schema.Unknown,
  fuel: Schema.Unknown,
  output: Schema.Unknown,
  burnTicksRemaining: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  cookTicks: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})

const potionItem = (value: typeof potion.Type) => {
  switch (value) {
    case 'awkward': return 'awkward_potion'
    case 'speed': return 'potion_of_swiftness'
    case 'poison': return 'potion_of_poison'
    case 'regeneration': return 'potion_of_regeneration'
  }
}

export const migrateLegacyBrewingState = (value: unknown): Result.Result<BrewingState, SavedServerStateFailure> => {
  const decoded = Schema.decodeUnknownResult(legacyBrewing)(value, { onExcessProperty: 'error' })
  if (Result.isFailure(decoded)) return Result.fail(savedServerStateFailure('brewingStands', 'invalid legacy brewing state'))
  const state = decoded.success
  if (state.brewing !== undefined && (state.bottle === undefined || state.ingredient !== undefined)) {
    return Result.fail(savedServerStateFailure('brewingStands', 'invalid legacy brewing progress'))
  }
  if (state.brewing === undefined && state.bottle !== undefined && state.ingredient !== undefined) {
    const compatible = state.bottle === 'water_bottle'
      ? state.ingredient === 'nether_wart'
      : state.bottle.potion === 'awkward' && state.ingredient !== 'nether_wart'
    if (!compatible) return Result.fail(savedServerStateFailure('brewingStands', 'invalid legacy brewing recipe'))
  }
  const charges = Math.min(state.fuelUnits, 20)
  // Only complete groups of 20 charges become powder; discard the remainder instead of creating fuel.
  const powder = Math.floor((state.fuelUnits - charges) / 20)
  if (powder > 64) return Result.fail(savedServerStateFailure('brewingStands', 'legacy brewing fuel exceeds one stack'))
  // Legacy starts already consumed the ingredient and one charge. Honor the paid output once on load;
  // the remaining brewing time is deliberately forgiven rather than charging those inputs again.
  const bottle = state.brewing !== undefined ? potionItem(state.brewing.output)
    : state.bottle === undefined ? undefined
    : state.bottle === 'water_bottle' ? 'water_bottle' : potionItem(state.bottle.potion)
  const migrated = brewingStateFromWire({
    bottles: [bottle === undefined ? null : { item: bottle, count: 1 }, null, null],
    ingredient: state.ingredient === undefined ? null : { item: state.ingredient, count: 1 },
    fuel: powder === 0 ? null : { item: 'blaze_powder', count: powder },
    fuelCharges: charges,
    brewProgressSecs: 0,
  })
  return Result.mapError(migrated, (failure) => savedServerStateFailure('brewingStands', failure.reason))
}

export const migrateLegacyFurnaces = (value: unknown): Result.Result<unknown, SavedServerStateFailure> => {
  const decoded = Schema.decodeUnknownResult(Schema.Array(legacyFurnace))(value, { onExcessProperty: 'error' })
  if (Result.isFailure(decoded)) return Result.fail(savedServerStateFailure('furnaces', 'invalid legacy furnace state'))
  return Result.succeed(decoded.success.map((furnace) => ({
    ...furnace, station: 'furnace', burnTicksTotal: furnace.burnTicksRemaining,
  })))
}
