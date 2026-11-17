import type { Result } from 'effect'

type EncodedStack = { readonly item: string; readonly count: number; readonly components: unknown }
type SinglePlayerBrewingMigrationFailure =
  | { readonly _tag: 'V17BrewingFuelOverflow'; readonly fuelUnits: number; readonly fuelItemCount: number; readonly maxStackCount: number }
  | { readonly _tag: 'V17BrewingStackRejected'; readonly item: string; readonly error: unknown }
  | { readonly _tag: 'V17BrewingStackUnencodable'; readonly item: string; readonly error: unknown }

export declare const migrateV17Brewing: (stand: unknown) => Result.Result<{
  readonly bottles: readonly [EncodedStack | null, null, null]
  readonly ingredient: EncodedStack | null
  readonly fuel: EncodedStack | null
  readonly fuelCharges: number
  readonly brewProgressSecs: 0
}, SinglePlayerBrewingMigrationFailure>
