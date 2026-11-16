#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer, type RequestListener, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

import { AIR_BLOCK_ID, blockIdOf, BlockPositionSchema, BlockStateValuesSchema, encodeBlockState, isBlockType } from '@nerima-games/mc-kernel'
import { containerCapacity, CONTAINER_STORAGE_SNAPSHOT_VERSION, ContainerStorageSnapshotSchema, durabilityForItem, DurabilitySchema, isDamageableItemType, isValidDurabilityForItem, LegacyItemStackSchema, type ContainerStoredStack, type Durability } from '@nerima-games/mc-sim'
import {
  CHUNK_HEIGHT,
  generatedChunkSource,
  NoiseSeed as WorldgenNoiseSeed,
  type Dimension,
} from '@nerima-games/mc-worldgen'
import {
  AuthoritativeSnapshot,
  ContainerKind,
  EntityId as EntityIdSchema,
  PlayerId as PlayerIdSchema,
  decodeFrame,
  type BlockPos,
  type CommandId,
  type Orientation,
  type PlayerId,
  type WireText,
  type WorldId,
} from '@nerima-games/mx-multiplayer'
import {
  decodeEnchantedItem,
  decodeEnderDragonEncounterSnapshot,
  isValidBrewingStandState,
  isValidStatusEffectState,
} from '@nerima-games/mx-gameplay'
import { Effect, Option, Result, Schema } from 'effect'
import { WebSocket, WebSocketServer } from 'ws'

import { isValidAnvilName } from '../multiplayer-shared/anvil-network.js'
import { isValidWitherRuntimeSnapshot } from '../multiplayer-shared/wither-runtime.js'
import { WITHER_MAX_WIRE_LENGTH } from '../multiplayer-shared/wither-network.js'
import {
  isWeatherClockState,
  chunkSourceFromBlocks,
  makeMultiplayerServerCore,
  makeTerrainReader,
  validateLoadedServerState,
  type MultiplayerServerCoreFailure,
  type WorldBlockReader,
  type MultiplayerServerCore,
  type MultiplayerServerState,
  type GeneratedBlockReadFailure,
} from './core.js'
import { makeMultiplayerServerCoreParts } from './entrypoints/core-parts.js'
import { loadLegacyPlayerClaims } from './legacy-player-claims.js'
import { createReconnectAuth } from './reconnect-auth.js'
import { makeMultiplayerRedstoneRuntime } from './redstone-runtime.js'
import { isAllowedWebSocketOrigin, resolveTransportSecurity } from './transport-security.js'

const DEFAULT_BLOCKS = [
  'bedrock',
  'chest',
  'coal_ore',
  'cobblestone',
  'dirt',
  'dispenser',
  'door',
  'dropper',
  'grass_block',
  'gravel',
  'iron_ore',
  'hopper',
  'lever',
  'oak_leaves',
  'oak_log',
  'oak_planks',
  'piston',
  'redstone_lamp',
  'redstone_torch',
  'redstone_wire',
  'sand',
  'stone',
] as const

const dimensionForWorld = (worldId: string): Dimension =>
  worldId === 'nether' || worldId === 'end' ? worldId : 'overworld'

export interface MultiplayerRuntimeOptions {
  readonly host: string
  readonly port: number
  readonly worldId: string
  readonly seed: number
  readonly allowedBlocks?: ReadonlySet<string>
  readonly installSignalHandlers?: boolean
  readonly stateFile?: string
  readonly tlsCert?: string
  readonly tlsKey?: string
  readonly allowedOrigins?: string
  readonly legacyPlayerClaimsFile?: string
  readonly maxMoveDistance?: number
}

export interface MultiplayerRuntime {
  readonly host: string
  readonly port: number
  readonly close: () => Promise<void>
}

type PlayerResume = Readonly<{
  _tag: 'PlayerResume'
  player: PlayerId
  token?: string
  registrationToken?: string
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const decodePlayerResume = (frame: string): PlayerResume | undefined => {
  let value: unknown
  try {
    value = JSON.parse(frame)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const resume = value
  if (
    resume['_tag'] !== 'PlayerResume'
    || typeof resume['player'] !== 'string'
    || resume['player'].length === 0
    || (resume['token'] !== undefined && typeof resume['token'] !== 'string')
    || (resume['registrationToken'] !== undefined && typeof resume['registrationToken'] !== 'string')
  ) return undefined
  const player = Schema.decodeUnknownResult(PlayerIdSchema)(resume['player'])
  if (Result.isFailure(player)) return undefined
  return {
    _tag: 'PlayerResume',
    player: player.success,
    ...(resume['token'] === undefined ? {} : { token: resume['token'] }),
    ...(resume['registrationToken'] === undefined ? {} : { registrationToken: resume['registrationToken'] }),
  }
}

const encodePlayerResumeAccepted = (player: PlayerId, token: string): string => JSON.stringify({
  _tag: 'PlayerResumeAccepted',
  player,
  token,
})

const valueAfter = (arguments_: ReadonlyArray<string>, name: string): string | undefined => {
  const equalsPrefix = `--${name}=`
  const equalsValue = arguments_.find((argument) => argument.startsWith(equalsPrefix))
  if (equalsValue !== undefined) return equalsValue.slice(equalsPrefix.length)
  const index = arguments_.indexOf(`--${name}`)
  return index >= 0 ? arguments_[index + 1] : undefined
}

const integerOption = (value: string | undefined, fallback: number, name: string): number => {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`)
  return parsed
}

export const resolveMultiplayerRuntimeOptions = (
  arguments_: ReadonlyArray<string> = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): MultiplayerRuntimeOptions => {
  const port = integerOption(valueAfter(arguments_, 'port') ?? environment['MULTIPLAYER_PORT'], 5182, 'port')
  const stateFile = valueAfter(arguments_, 'state-file') ?? environment['MULTIPLAYER_STATE_FILE']
  const tlsCert = valueAfter(arguments_, 'tls-cert') ?? environment['MULTIPLAYER_TLS_CERT']
  const tlsKey = valueAfter(arguments_, 'tls-key') ?? environment['MULTIPLAYER_TLS_KEY']
  const allowedOrigins = valueAfter(arguments_, 'allowed-origins') ?? environment['MULTIPLAYER_ALLOWED_ORIGINS']
  const legacyPlayerClaimsFile = valueAfter(arguments_, 'legacy-player-claims-file')
    ?? environment['MULTIPLAYER_LEGACY_PLAYER_CLAIMS_FILE']
  if (port < 0 || port > 65_535) throw new Error('port must be between 0 and 65535')
  const options: MultiplayerRuntimeOptions = {
    host: valueAfter(arguments_, 'host') ?? environment['MULTIPLAYER_HOST'] ?? '127.0.0.1',
    port,
    worldId: valueAfter(arguments_, 'world') ?? environment['MULTIPLAYER_WORLD'] ?? 'overworld',
    seed: integerOption(valueAfter(arguments_, 'seed') ?? environment['MULTIPLAYER_SEED'], 0, 'seed'),
    ...(stateFile === undefined ? {} : { stateFile }),
    ...(tlsCert === undefined ? {} : { tlsCert }),
    ...(tlsKey === undefined ? {} : { tlsKey }),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    ...(legacyPlayerClaimsFile === undefined ? {} : { legacyPlayerClaimsFile }),
    installSignalHandlers: true,
  }
  resolveTransportSecurity(options)
  return options
}

interface PersistedServerState {
  readonly format: 2
  readonly worldId: string
  readonly seed: number
  readonly state: unknown
}

type SavedItemStackFailure = Extract<MultiplayerServerCoreFailure, { _tag: 'SavedItemStackFailure' }>

type SavedContainerIdFailure = Extract<MultiplayerServerCoreFailure, { _tag: 'SavedContainerIdInvalid' }>
type ServerStateWriteFailure = SavedItemStackFailure | SavedContainerIdFailure
const migratedContainerId = (value: unknown, worldId: string, format: 1 | 2): Result.Result<string, ServerStateWriteFailure> => {
  const parsed = Schema.decodeUnknownResult(Schema.String)(value)
  if (Result.isFailure(parsed)) return Result.fail({ _tag: 'SavedItemStackFailure', path: 'containers', failure: parsed.failure })
  const id = parsed.success
  const dimension = dimensionForWorld(worldId)
  const prefix = format === 1 ? worldId : dimension
  if (!id.startsWith(`${prefix}:`)) return Result.fail({ _tag: 'SavedContainerIdInvalid', containerId: id })
  const suffix = id.slice(prefix.length + 1)
  const match = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(suffix)
  if (match === null || match[0] !== suffix) return Result.fail({ _tag: 'SavedContainerIdInvalid', containerId: id })
  const position = Schema.decodeUnknownResult(BlockPositionSchema)({ x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) })
  if (Result.isFailure(position) || position.success.y < 0 || position.success.y >= CHUNK_HEIGHT) {
    return Result.fail({ _tag: 'SavedContainerIdInvalid', containerId: id })
  }
  const canonical = `${dimension}:${String(position.success.x)},${String(position.success.y)},${String(position.success.z)}`
  if (format === 2 && id !== canonical) return Result.fail({ _tag: 'SavedContainerIdInvalid', containerId: id })
  return Result.succeed(canonical)
}

type SavedItemTransform = Readonly<{
  state: unknown
  containerItems: ReadonlyMap<string, ContainerStoredStack>
}>
const savedStackFields = Schema.Struct({ item: Schema.String, count: Schema.Number, components: Schema.Unknown })
const itemPaths: ReadonlyArray<ReadonlyArray<string>> = [
  ['inventories', '*', 'state', 'slots', '*'],
  ...['head', 'chest', 'legs', 'feet', 'offhand'].map((slot) => ['inventories', '*', 'state', 'equipment', slot]),
  ['containers', '*', 'slots', '*'],
  ...['input', 'fuel', 'output'].map((slot) => ['furnaces', '*', slot]),
  ['villagerTrades', '*', 'offers', '*', 'input', '*'],
  ['villagerTrades', '*', 'offers', '*', 'output'],
  ['entities', '*', 'stack'],
]
const transformSavedItems = (
  value: unknown,
  format: 1 | 2,
  direction: 'read' | 'write',
): Result.Result<SavedItemTransform, SavedItemStackFailure> => {
  const containerItems = new Map<string, ContainerStoredStack>()
  const stackAt = (value: unknown, path: string): Result.Result<unknown, SavedItemStackFailure> => {
    if (value === null) return Result.succeed(null)
    const record = Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Unknown))(value)
    if (Result.isFailure(record)) return Result.fail({ _tag: 'SavedItemStackFailure', path, failure: record.failure })
    const fields = Schema.decodeUnknownResult(Schema.Struct({ item: Schema.String, count: Schema.Number }))(record.success)
    if (Result.isFailure(fields)) return Result.fail({ _tag: 'SavedItemStackFailure', path, failure: fields.failure })
    const stack = record.success
    const container = path.startsWith('containers.')
    if (direction === 'read' && format === 1 && Object.hasOwn(stack, 'components')) {
      const components = Schema.decodeUnknownResult(Schema.Null)(stack['components'])
      if (Result.isFailure(components)) return Result.fail({ _tag: 'SavedItemStackFailure', path, failure: components.failure })
    }
    const canonical = direction === 'write' && (container || (Object.hasOwn(stack, 'components') && stack['components'] !== null))
      ? Schema.decodeUnknownResult(Schema.toType(LegacyItemStackSchema))({
          ...fields.success, components: stack['components'],
        })
      : Schema.decodeUnknownResult(LegacyItemStackSchema)({
          ...fields.success,
          components: direction === 'write' || format === 1 ? null : stack['components'],
        })
    if (Result.isFailure(canonical)) return Result.fail({ _tag: 'SavedItemStackFailure', path, failure: canonical.failure })
    const encoded = Schema.encodeResult(LegacyItemStackSchema)(canonical.success)
    if (Result.isFailure(encoded)) return Result.fail({ _tag: 'SavedItemStackFailure', path, failure: encoded.failure })
    const saved = Schema.decodeUnknownResult(savedStackFields)(encoded.success)
    if (Result.isFailure(saved)) return Result.fail({ _tag: 'SavedItemStackFailure', path, failure: saved.failure })
    if (!container) {
      const components = Schema.decodeUnknownResult(Schema.Null)(saved.success.components)
      if (Result.isFailure(components)) return Result.fail({ _tag: 'SavedItemStackFailure', path, failure: components.failure })
    }
    const durability = Schema.decodeUnknownResult(Schema.NullOr(DurabilitySchema))(
      Object.hasOwn(stack, 'durability') ? stack['durability']
        : container ? format === 1 && direction === 'read' ? durabilityForItem(canonical.success.item) : undefined
        : null,
    )
    if (Result.isFailure(durability)) return Result.fail({ _tag: 'SavedItemStackFailure', path, failure: durability.failure })
    if (container) {
      const paired = Schema.decodeUnknownResult(Schema.declare((value: unknown): value is Durability | null =>
        isDamageableItemType(canonical.success.item) ? isValidDurabilityForItem(canonical.success.item, value) : value === null,
      ))(durability.success)
      if (Result.isFailure(paired)) return Result.fail({ _tag: 'SavedItemStackFailure', path, failure: paired.failure })
    }
    if (direction === 'write') {
      return Result.succeed({
        ...saved.success,
        ...(container || durability.success !== null ? { durability: durability.success } : {}),
      })
    }
    if (container) containerItems.set(path, { ...canonical.success, durability: durability.success })
    return Result.succeed({
      item: canonical.success.item, count: canonical.success.count,
      ...(durability.success === null ? {} : { durability: durability.success }),
    })
  }
  const visit = (value: unknown, selectors: ReadonlyArray<string>, path: string): Result.Result<unknown, SavedItemStackFailure> => {
    const [selector, ...rest] = selectors
    if (selector === undefined) return stackAt(value, path)
    if (selector === '*' && Array.isArray(value)) {
      const entries: Array<unknown> = []
      for (const [index, entry] of value.entries()) {
        const transformed = visit(entry, rest, `${path}.${String(index)}`)
        if (Result.isFailure(transformed)) return transformed
        entries.push(transformed.success)
      }
      return Result.succeed(entries)
    }
    if (!isRecord(value) || !Object.hasOwn(value, selector)) return Result.succeed(value)
    const transformed = visit(value[selector], rest, path === '' ? selector : `${path}.${selector}`)
    return Result.map(transformed, (entry) => ({ ...value, [selector]: entry }))
  }
  let state = value
  for (const path of itemPaths) {
    const transformed = visit(state, path, '')
    if (Result.isFailure(transformed)) return Result.fail(transformed.failure)
    state = transformed.success
  }
  return Result.succeed({ state, containerItems })
}


const validatePersistentContainers = (
  containers: MultiplayerServerState['containers'],
  worldId: string,
): Result.Result<void, ServerStateWriteFailure> => {
  for (const container of containers) {
    const id = migratedContainerId(container.containerId, worldId, 2)
    if (Result.isFailure(id)) return Result.fail(id.failure)
  }
  const decoded = Schema.decodeUnknownResult(ContainerStorageSnapshotSchema)({
    version: CONTAINER_STORAGE_SNAPSHOT_VERSION,
    containers: containers.map(({ containerId, kind, slots }) => ({ id: containerId, kind, slots })),
  })
  if (Result.isFailure(decoded)) return Result.fail({ _tag: 'SavedItemStackFailure', path: 'containers', failure: decoded.failure })
  return Result.succeed(undefined)
}

const isBlockPos = (value: unknown): value is BlockPos => {
  if (!isRecord(value)) return false
  const position = value
  return Number.isInteger(position['x']) && Number.isInteger(position['y']) && Number.isInteger(position['z'])
}

const isPlayerPosition = (value: unknown): value is BlockPos => {
  if (!isRecord(value)) return false
  const position = value
  return typeof position['x'] === 'number' && Number.isFinite(position['x'])
    && typeof position['y'] === 'number' && Number.isFinite(position['y'])
    && typeof position['z'] === 'number' && Number.isFinite(position['z'])
}

const isOrientation = (value: unknown): value is Orientation => {
  if (!isRecord(value)) return false
  const orientation = value
  return typeof orientation['yawRadians'] === 'number' && Number.isFinite(orientation['yawRadians'])
    && typeof orientation['pitchRadians'] === 'number' && Number.isFinite(orientation['pitchRadians'])
}

const decodeServerState = (value: unknown, worldId: string, format: 1 | 2): Result.Result<MultiplayerServerState | undefined, MultiplayerServerCoreFailure> => {
  const items = transformSavedItems(value, format, 'read')
  if (Result.isFailure(items)) return Result.fail(items.failure)
  if (!isRecord(items.success.state)) return Result.succeed(undefined)
  const state = items.success.state
  const revision = state['revision']
  const blocksValue = state['blocks']
  if (!isNonNegativeSafeInteger(revision) || !Array.isArray(blocksValue)) return Result.succeed(undefined)
  const blocks: Array<MultiplayerServerState['blocks'][number]> = []
  for (const entry of blocksValue) {
    if (!isRecord(entry) || !isBlockPos(entry['at']) || (entry['block'] !== null && typeof entry['block'] !== 'string')) return Result.succeed(undefined)
    const mutation = { at: entry['at'], block: entry['block'] }
    if (!Object.hasOwn(entry, 'state')) {
      blocks.push(mutation)
      continue
    }
    const blockId = mutation.block === null
      ? Option.some(AIR_BLOCK_ID)
      : isBlockType(mutation.block) ? blockIdOf(mutation.block) : Option.none()
    if (Option.isNone(blockId)) return Result.fail({ _tag: 'BlockOverrideNotInRegistry', at: mutation.at, block: String(mutation.block) })
    const blockState = Schema.decodeUnknownResult(BlockStateValuesSchema)(entry['state'])
    if (Result.isFailure(blockState)) return Result.fail({ _tag: 'SavedBlockStateFailure', at: mutation.at, failure: blockState.failure })
    const encoded = encodeBlockState(blockId.value, blockState.success)
    if (Result.isFailure(encoded)) return Result.fail({ _tag: 'SavedBlockStateFailure', at: mutation.at, failure: encoded.failure })
    blocks.push({ ...mutation, state: blockState.success })
  }

  const poweredRailsValue = state['poweredRails']
  if (poweredRailsValue !== undefined && !Array.isArray(poweredRailsValue)) return Result.succeed(undefined)
  const poweredRails = poweredRailsValue === undefined
    ? []
    : poweredRailsValue.flatMap((entry: unknown) => {
        if (!isRecord(entry) || !isBlockPos(entry['at']) || typeof entry['powered'] !== 'boolean') return []
        return [{ at: entry['at'], powered: entry['powered'] }]
      })
  if (poweredRailsValue !== undefined && poweredRails.length !== poweredRailsValue.length) return Result.succeed(undefined)

  const playerPositionsValue = state['playerPositions']
  if (playerPositionsValue !== undefined && !Array.isArray(playerPositionsValue)) return Result.succeed(undefined)
  const playerPositions = playerPositionsValue === undefined
    ? []
    : playerPositionsValue.flatMap((entry: unknown) => {
        if (!isRecord(entry) || !isPlayerPosition(entry['at']) || !isOrientation(entry['facing'])) return []
        const player = Schema.decodeUnknownResult(PlayerIdSchema)(entry['player'])
        return Result.isFailure(player) ? [] : [{ player: player.success, at: entry['at'], facing: entry['facing'] }]
      })
  if (playerPositionsValue !== undefined && playerPositions.length !== playerPositionsValue.length) return Result.succeed(undefined)

  const eyeOfEnderRecoveriesValue = state['eyeOfEnderRecoveries']
  if (eyeOfEnderRecoveriesValue !== undefined && !Array.isArray(eyeOfEnderRecoveriesValue)) return Result.succeed(undefined)
  const eyeOfEnderRecoveries = eyeOfEnderRecoveriesValue === undefined
    ? []
    : eyeOfEnderRecoveriesValue.flatMap((entry: unknown) => {
        if (!isRecord(entry) || !isPlayerPosition(entry['at']) || typeof entry['remainingSecs'] !== 'number'
          || !Number.isFinite(entry['remainingSecs']) || entry['remainingSecs'] <= 0) return []
        const entityId = Schema.decodeUnknownResult(EntityIdSchema)(entry['entityId'])
        return Result.isFailure(entityId)
          ? []
          : [{ entityId: entityId.success, at: entry['at'], remainingSecs: entry['remainingSecs'] }]
      })
  if (eyeOfEnderRecoveriesValue !== undefined && eyeOfEnderRecoveries.length !== eyeOfEnderRecoveriesValue.length) return Result.succeed(undefined)

  const weatherClock = state['weatherClock']
  if (weatherClock !== undefined && !isWeatherClockState(weatherClock)) return Result.succeed(undefined)

  const witherValue = state['wither']
  if (witherValue !== undefined && !isValidWitherRuntimeSnapshot(witherValue)) return Result.succeed(undefined)
  const wither = witherValue

  const witherRevisionValue = state['witherRevision']
  const witherRevision = witherRevisionValue === undefined
    ? undefined
    : isNonNegativeSafeInteger(witherRevisionValue)
      ? witherRevisionValue
      : null
  if (witherRevision === null) return Result.succeed(undefined)

  const leversValue = state['levers']
  if (leversValue !== undefined && !Array.isArray(leversValue)) return Result.succeed(undefined)
  const levers = leversValue === undefined
    ? []
    : leversValue.flatMap((entry: unknown) => {
        if (!isRecord(entry) || !isBlockPos(entry['at']) || typeof entry['active'] !== 'boolean') return []
        return [{ at: entry['at'], active: entry['active'] }]
      })
  if (leversValue !== undefined && levers.length !== leversValue.length) return Result.succeed(undefined)

  const enderDragonValue = state['enderDragon']
  const enderDragon = enderDragonValue === undefined ? undefined : decodeEnderDragonEncounterSnapshot(enderDragonValue)
  if (enderDragonValue !== undefined && enderDragon === undefined) return Result.succeed(undefined)

  const enderDragonRevisionValue = state['enderDragonRevision']
  const enderDragonRevision = enderDragonRevisionValue === undefined
    ? undefined
    : isNonNegativeSafeInteger(enderDragonRevisionValue)
      ? enderDragonRevisionValue
      : null
  if (enderDragonRevision === null) return Result.succeed(undefined)

  const brewingStandsValue = state['brewingStands']
  if (brewingStandsValue !== undefined && !Array.isArray(brewingStandsValue)) return Result.succeed(undefined)
  const brewingStands = brewingStandsValue === undefined
    ? []
    : brewingStandsValue.flatMap((entry: unknown) => {
        if (!isRecord(entry) || !isBlockPos(entry['at']) || !isValidBrewingStandState(entry['state'])) return []
        return [{ at: entry['at'], state: entry['state'] }]
      })
  if (brewingStandsValue !== undefined && brewingStands.length !== brewingStandsValue.length) return Result.succeed(undefined)

  const statusEffectsValue = state['statusEffects']
  if (statusEffectsValue !== undefined && !Array.isArray(statusEffectsValue)) return Result.succeed(undefined)
  const statusEffects = statusEffectsValue === undefined
    ? []
    : statusEffectsValue.flatMap((entry: unknown) => {
        if (!isRecord(entry) || !isValidStatusEffectState(entry['state'])) return []
        const player = Schema.decodeUnknownResult(PlayerIdSchema)(entry['player'])
        return Result.isFailure(player) ? [] : [{ player: player.success, state: entry['state'] }]
      })
  if (statusEffectsValue !== undefined && statusEffects.length !== statusEffectsValue.length) return Result.succeed(undefined)

  const anvilNamesValue = state['anvilNames']
  if (anvilNamesValue !== undefined && !Array.isArray(anvilNamesValue)) return Result.succeed(undefined)
  const anvilNames = anvilNamesValue === undefined
    ? []
    : anvilNamesValue.flatMap((entry: unknown) => {
        if (!isRecord(entry) || !Array.isArray(entry['names'])) return []
        const player = Schema.decodeUnknownResult(PlayerIdSchema)(entry['player'])
        if (Result.isFailure(player)) return []
        const names = entry['names'].flatMap((nameEntry: unknown) => {
          if (!isRecord(nameEntry) || !isNonNegativeSafeInteger(nameEntry['slot']) || !isValidAnvilName(nameEntry['name'])) return []
          return [{ slot: nameEntry['slot'], name: nameEntry['name'] }]
        })
        if (names.length !== entry['names'].length) return []
        return [{ player: player.success, names }]
      })
  if (anvilNamesValue !== undefined && anvilNames.length !== anvilNamesValue.length) return Result.succeed(undefined)

  const enchantmentsValue = state['enchantments']
  if (enchantmentsValue !== undefined && !Array.isArray(enchantmentsValue)) return Result.succeed(undefined)
  const enchantments = enchantmentsValue === undefined
    ? []
    : enchantmentsValue.flatMap((entry: unknown) => {
        if (!isRecord(entry) || !isNonNegativeSafeInteger(entry['seed']) || !Array.isArray(entry['items'])) return []
        const player = Schema.decodeUnknownResult(PlayerIdSchema)(entry['player'])
        if (Result.isFailure(player)) return []
        const items = entry['items'].flatMap((itemEntry: unknown) => {
          if (!isRecord(itemEntry) || !isNonNegativeSafeInteger(itemEntry['slot'])) return []
          const decoded = decodeEnchantedItem(itemEntry['item'])
          return decoded.ok ? [{ slot: itemEntry['slot'], item: decoded.value }] : []
        })
        if (items.length !== entry['items'].length) return []
        return [{ player: player.success, seed: entry['seed'], items }]
      })
  if (enchantmentsValue !== undefined && enchantments.length !== enchantmentsValue.length) return Result.succeed(undefined)

  const savedContainers = state['containers'] === undefined ? [] : state['containers']
  const migratedContainers = Array.isArray(savedContainers)
    ? savedContainers.map((container) => {
        if (format !== 1 || !isRecord(container) || !Array.isArray(container['slots'])) return container
        const kind = Schema.decodeUnknownResult(ContainerKind)(container['kind'] === undefined ? 'chest' : container['kind'])
        if (Result.isFailure(kind)) return container
        const slots = container['slots']
        return {
          ...container,
          kind: kind.success,
          slots: [...slots, ...Array.from({ length: Math.max(0, containerCapacity(kind.success) - slots.length) }, () => null)],
        }
      })
    : savedContainers
  const canonicalIds: Array<unknown> = []
  if (Array.isArray(migratedContainers)) {
    for (const container of migratedContainers) {
      if (!isRecord(container) || typeof container['containerId'] !== 'string') {
        canonicalIds.push(container)
        continue
      }
      const id = migratedContainerId(container['containerId'], worldId, format)
      if (Result.isFailure(id)) return Result.fail(id.failure)
      canonicalIds.push({ ...container, containerId: id.success })
    }
  }
  const stored = Schema.decodeUnknownResult(ContainerStorageSnapshotSchema)({
    version: CONTAINER_STORAGE_SNAPSHOT_VERSION,
    containers: Array.isArray(migratedContainers)
      ? canonicalIds.map((container, containerIndex) => !isRecord(container) ? container : ({
          id: container['containerId'], kind: container['kind'],
          slots: Array.isArray(container['slots'])
            ? container['slots'].map((slot, slotIndex) => slot === null ? null
              : items.success.containerItems.get(`containers.${String(containerIndex)}.slots.${String(slotIndex)}`))
            : container['slots'],
        }))
      : migratedContainers,
  })
  if (Result.isFailure(stored)) return Result.fail({ _tag: 'SavedItemStackFailure', path: 'containers', failure: stored.failure })
  const containers = stored.success.containers.map(({ id, kind, slots }) => ({ containerId: id, kind, slots }))
  const decoded = Schema.decodeUnknownResult(AuthoritativeSnapshot)({
    _tag: 'AuthoritativeSnapshot',
    world: worldId,
    revision,
    inventories: state['inventories'] ?? [],
    vitals: state['vitals'] ?? [],
    timeWeather: state['timeWeather'] ?? { timeOfDay: 6_000, weather: 'clear' },
    containers: containers.map((container) => ({
      ...container,
      slots: container.slots.map((stack) => stack === null ? null : ({
        item: stack.item, count: stack.count,
        ...(stack.durability === null ? {} : { durability: stack.durability }),
      })),
    })),
    furnaces: state['furnaces'] ?? [],
    villagerTrades: state['villagerTrades'] ?? [],
    entities: state['entities'] ?? [],
  })
  if (Result.isFailure(decoded)) return Result.succeed(undefined)
  const snapshot = decoded.success
  return Result.succeed({
    revision: snapshot.revision,
    blocks,
    poweredRails,
    inventories: snapshot.inventories,
    vitals: snapshot.vitals,
    timeWeather: snapshot.timeWeather,
    ...(weatherClock === undefined ? {} : { weatherClock }),
    containers,
    furnaces: snapshot.furnaces,
    villagerTrades: snapshot.villagerTrades,
    entities: snapshot.entities ?? [],
    eyeOfEnderRecoveries,
    playerPositions,
    ...(wither === undefined ? {} : { wither }),
    ...(witherRevision === undefined ? {} : { witherRevision }),
    levers,
    ...(enderDragon === undefined ? {} : { enderDragon }),
    ...(enderDragonRevision === undefined ? {} : { enderDragonRevision }),
    brewingStands,
    statusEffects,
    anvilNames,
    enchantments,
  })
}

export const loadServerState = async (
  path: string,
  worldId: string,
  seed: number,
): Promise<Result.Result<MultiplayerServerState | undefined, MultiplayerServerCoreFailure>> => {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Result.succeed(undefined)
    throw new Error(`Failed to read multiplayer state: ${path}`, { cause: error })
  }
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Failed to read multiplayer state: ${path}`, { cause: error })
  }
  if (!isRecord(value)) throw new Error(`invalid multiplayer state file: ${path}`)
  const persisted = value
  const format = persisted['format']
  if ((format !== 1 && format !== 2) || persisted['worldId'] !== worldId || persisted['seed'] !== seed) {
    throw new Error(`multiplayer state file does not match world ${worldId} and seed ${String(seed)}: ${path}`)
  }
  const decodedState = decodeServerState(persisted['state'], worldId, format)
  if (Result.isFailure(decodedState)) return Result.fail(decodedState.failure)
  const state = decodedState.success
  if (state === undefined) {
    throw new Error(`multiplayer state file does not match world ${worldId} and seed ${String(seed)}: ${path}`)
  }
  // An unaddressable position or a mob state mx-gameplay cannot repair would otherwise stop every tick of this dimension.
  return Result.map(validateLoadedServerState(state), () => state)
}

export const writeServerState = async (
  path: string,
  worldId: string,
  seed: number,
  state: MultiplayerServerState,
): Promise<Result.Result<void, ServerStateWriteFailure>> => {
  const encoded = transformSavedItems(state, 2, 'write')
  if (Result.isFailure(encoded)) return Result.fail(encoded.failure)
  const validContainers = validatePersistentContainers(state.containers, worldId)
  if (Result.isFailure(validContainers)) return validContainers
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`
  const persisted: PersistedServerState = { format: 2, worldId, seed, state: encoded.success.state }
  await writeFile(temporaryPath, `${JSON.stringify(persisted)}\n`, 'utf8')
  await rename(temporaryPath, path)
  return Result.succeed(undefined)
}

export type LatestStatePersistence<State> = {
  readonly request: (state: State) => void
  readonly drain: () => Promise<void>
}

export const createLatestStatePersistence = <State>(
  write: (state: State) => Promise<void>,
  onFailure: (failure: unknown) => void,
): LatestStatePersistence<State> => {
  let pending!: State
  let hasPending = false
  let running: Promise<void> | undefined
  let failure: unknown
  let failed = false

  const start = (): void => {
    if (running !== undefined || !hasPending || failed) return
    let complete!: () => void
    running = new Promise<void>((resolve) => { complete = resolve })
    void (async () => {
      while (hasPending) {
        const state = pending
        hasPending = false
        try {
          await write(state)
        } catch (error: unknown) {
          failure = error
          failed = true
          hasPending = false
          onFailure(error)
          return
        }
      }
    })().finally(() => {
      running = undefined
      if (hasPending && !failed) start()
      complete()
    })
  }

  return {
    request: (state) => {
      if (failed) return
      pending = state
      hasPending = true
      start()
    },
    drain: async () => {
      if (failed) throw failure
      while (running !== undefined || hasPending) {
        start()
        await running
        if (failed) throw failure
      }
    },
  }
}

const findSpawnAt = (
  blockAt: WorldBlockReader['blockAt'],
): Result.Result<BlockPos, MultiplayerServerCoreFailure> => {
  for (let y = CHUNK_HEIGHT - 2; y >= 0; y -= 1) {
    const ground = blockAt({ x: 0, y, z: 0 })
    if (Result.isFailure(ground)) return Result.fail(ground.failure)
    const feet = blockAt({ x: 0, y: y + 1, z: 0 })
    if (Result.isFailure(feet)) return Result.fail(feet.failure)
    const head = blockAt({ x: 0, y: y + 2, z: 0 })
    if (Result.isFailure(head)) return Result.fail(head.failure)
    if (ground.success !== null && feet.success === null && head.success === null) {
      return Result.succeed({ x: 0, y: y + 1, z: 0 })
    }
  }
  return Result.succeed({ x: 0, y: 64, z: 0 })
}

const listen = (server: HttpServer, port: number, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('multiplayer server did not bind a TCP address'))
        return
      }
      resolve(address.port)
    })
  })

export const startMultiplayerServer = async (
  options: MultiplayerRuntimeOptions,
): Promise<Result.Result<MultiplayerRuntime, GeneratedBlockReadFailure | MultiplayerServerCoreFailure>> => {
  const noiseSeed = WorldgenNoiseSeed.result(options.seed)
  if (Result.isFailure(noiseSeed)) return Result.fail({ _tag: 'GeneratedNoiseSeedFailure', failure: noiseSeed.failure })
  // Both realms have always generated from the overworld terrain generator; the End is only its static blocks.
  const terrainSource = generatedChunkSource(noiseSeed.success)
  const coreParts = makeMultiplayerServerCoreParts()
  // Spawn is chosen from generated terrain only, through the same reader the cores use.
  const terrain = makeTerrainReader(terrainSource, coreParts)
  const overworldSpawnResult = findSpawnAt(terrain.blockAt)
  if (Result.isFailure(overworldSpawnResult)) return Result.fail(overworldSpawnResult.failure)
  const netherSpawnResult = findSpawnAt(terrain.blockAt)
  if (Result.isFailure(netherSpawnResult)) return Result.fail(netherSpawnResult.failure)
  const overworldSpawnAt = overworldSpawnResult.success
  const netherSpawnAt = netherSpawnResult.success
  const transportSecurity = resolveTransportSecurity(options)
  const stateFile = options.stateFile
  const initialStateResult = stateFile === undefined
    ? Result.succeed(undefined)
    : await loadServerState(stateFile, options.worldId, options.seed)
  if (Result.isFailure(initialStateResult)) return Result.fail(initialStateResult.failure)
  const initialState = initialStateResult.success
  const legacyPlayers = new Set([
    ...(initialState?.inventories.map(({ player }) => player) ?? []),
    ...(initialState?.vitals.map(({ player }) => player) ?? []),
    ...(initialState?.playerPositions?.map(({ player }) => player) ?? []),
  ])
  const legacyPlayerClaims = options.legacyPlayerClaimsFile === undefined
    ? undefined
    : await loadLegacyPlayerClaims(options.legacyPlayerClaimsFile)
  const reconnectAuth = await createReconnectAuth(stateFile)
  let persistenceFailed = false
  const onPersistenceFailure = (failure: unknown): void => {
    if (persistenceFailed) return
    persistenceFailed = true
    console.error('Multiplayer state persistence failed', { failure })
    if (options.installSignalHandlers === true) process.exitCode = 1
    void close().catch((shutdownFailure: unknown) => {
      if (shutdownFailure !== failure) console.error('Multiplayer server shutdown failed', { failure: shutdownFailure })
    })
  }
  const persistence = stateFile === undefined
    ? undefined
    : createLatestStatePersistence(async (state: MultiplayerServerState) =>
        Result.getOrThrow(await writeServerState(stateFile, options.worldId, options.seed, state)),
        onPersistenceFailure,
      )
  const endStateFile = stateFile === undefined ? undefined : `${stateFile}.end`
  const endInitialStateResult = endStateFile === undefined
    ? Result.succeed(undefined)
    : await loadServerState(endStateFile, 'end', options.seed)
  if (Result.isFailure(endInitialStateResult)) return Result.fail(endInitialStateResult.failure)
  const endInitialState = endInitialStateResult.success
  const endPersistence = endStateFile === undefined
    ? undefined
    : createLatestStatePersistence(async (state: MultiplayerServerState) =>
        Result.getOrThrow(await writeServerState(endStateFile, 'end', options.seed, state)),
        onPersistenceFailure,
      )
  const netherStateFile = stateFile === undefined ? undefined : `${stateFile}.nether`
  const netherInitialStateResult = netherStateFile === undefined
    ? Result.succeed(undefined)
    : await loadServerState(netherStateFile, 'nether', options.seed)
  if (Result.isFailure(netherInitialStateResult)) return Result.fail(netherInitialStateResult.failure)
  const netherInitialState = netherInitialStateResult.success
  const netherPersistence = netherStateFile === undefined
    ? undefined
    : createLatestStatePersistence(async (state: MultiplayerServerState) =>
        Result.getOrThrow(await writeServerState(netherStateFile, 'nether', options.seed, state)),
        onPersistenceFailure,
      )
  const endSpawnAt: BlockPos = { x: 0, y: 64, z: 0 }
  const overworldNetherPortalAt: BlockPos = { x: overworldSpawnAt.x - 1, y: overworldSpawnAt.y, z: overworldSpawnAt.z }
  const netherPortalAt: BlockPos = { x: netherSpawnAt.x + 1, y: netherSpawnAt.y, z: netherSpawnAt.z }
  const endStaticBlocks = [
    ...Array.from({ length: 49 }, (_, index) => ({
      at: { x: (index % 7) - 3, y: 63, z: Math.floor(index / 7) - 3 },
      block: 'end_stone',
    })),
    { at: { x: 1, y: 64, z: 0 }, block: 'end_portal' },
  ]
  const activeRealms = new Map<string, MultiplayerServerCore>()
  let overworldCore: MultiplayerServerCore
  let netherCore: MultiplayerServerCore
  let endCore: MultiplayerServerCore
  const transferPlayer = (
    clientId: string,
    source: MultiplayerServerCore,
    destination: MultiplayerServerCore,
    destinationAt: BlockPos,
    command: Readonly<{ commandId: CommandId; world: WorldId }>,
  ): void => {
    const preparedBlockSnapshot = destination.prepareRealmTransfer()
    if (Result.isFailure(preparedBlockSnapshot)) {
      console.error('Multiplayer realm transfer failed', { clientId, failure: preparedBlockSnapshot.failure })
      return
    }
    const detached = source.detachPlayer(clientId)
    if (Result.isFailure(detached)) {
      console.error('Multiplayer realm transfer failed', { clientId, failure: detached.failure })
      return
    }
    const transfer = detached.success
    if (transfer === undefined) return
    if (!destination.acceptRealmTransfer(clientId, transfer, {
      commandId: command.commandId,
      fromWorld: command.world,
      at: destinationAt,
      facing: transfer.facing,
    }, preparedBlockSnapshot.success)) return
    activeRealms.set(clientId, destination)
  }
  const overworldCoreResult = makeMultiplayerServerCore({
    worldId: options.worldId,
    dimension: dimensionForWorld(options.worldId),
    seed: options.seed,
    allowedBlocks: options.allowedBlocks ?? new Set(DEFAULT_BLOCKS),
    chunkSource: terrainSource,
    parts: coreParts,
    spawnAt: overworldSpawnAt,
    staticBlocks: [
      { at: overworldNetherPortalAt, block: 'nether_portal' },
    ],
    ...(initialState === undefined ? {} : { initialState }),
    ...(persistence === undefined ? {} : { onStateChanged: persistence.request }),
    ...(options.maxMoveDistance === undefined ? {} : { maxMoveDistance: options.maxMoveDistance }),
    passableBlocks: new Set(['water', 'end_portal', 'nether_portal']),
    onEndPortalUse: (clientId, command) => transferPlayer(clientId, overworldCore, endCore, endSpawnAt, command),
    onNetherPortalUse: (clientId, command) => transferPlayer(clientId, overworldCore, netherCore, netherSpawnAt, command),
  })
  if (Result.isFailure(overworldCoreResult)) return Result.fail(overworldCoreResult.failure)
  overworldCore = overworldCoreResult.success
  const netherCoreResult = makeMultiplayerServerCore({
    worldId: 'nether',
    dimension: 'nether',
    seed: options.seed,
    allowedBlocks: options.allowedBlocks ?? new Set(DEFAULT_BLOCKS),
    chunkSource: terrainSource,
    parts: coreParts,
    spawnAt: netherSpawnAt,
    staticBlocks: [{ at: netherPortalAt, block: 'nether_portal' }],
    ...(netherInitialState === undefined ? {} : { initialState: netherInitialState }),
    ...(netherPersistence === undefined ? {} : { onStateChanged: netherPersistence.request }),
    ...(options.maxMoveDistance === undefined ? {} : { maxMoveDistance: options.maxMoveDistance }),
    passableBlocks: new Set(['water', 'nether_portal']),
    onNetherPortalUse: (clientId, command) => transferPlayer(clientId, netherCore, overworldCore, overworldSpawnAt, command),
  })
  if (Result.isFailure(netherCoreResult)) return Result.fail(netherCoreResult.failure)
  netherCore = netherCoreResult.success
  const endCoreResult = makeMultiplayerServerCore({
    worldId: 'end',
    dimension: 'end',
    seed: options.seed,
    allowedBlocks: options.allowedBlocks ?? new Set(DEFAULT_BLOCKS),
    chunkSource: chunkSourceFromBlocks('END', () => AIR_BLOCK_ID),
    parts: coreParts,
    spawnAt: endSpawnAt,
    staticBlocks: endStaticBlocks,
    ...(endInitialState === undefined ? {} : { initialState: endInitialState }),
    ...(endPersistence === undefined ? {} : { onStateChanged: endPersistence.request }),
    ...(options.maxMoveDistance === undefined ? {} : { maxMoveDistance: options.maxMoveDistance }),
    passableBlocks: new Set(['water', 'end_portal']),
    onEndPortalUse: (clientId, command) => transferPlayer(clientId, endCore, overworldCore, overworldSpawnAt, command),
  })
  if (Result.isFailure(endCoreResult)) return Result.fail(endCoreResult.failure)
  endCore = endCoreResult.success
  const redstoneRuntime = await makeMultiplayerRedstoneRuntime([
    { dimension: dimensionForWorld(options.worldId), core: overworldCore },
    { dimension: 'nether', core: netherCore },
    { dimension: 'end', core: endCore },
  ])
  const requestHandler: RequestListener = (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ status: 'ok', world: options.worldId }))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found')
  }
  const server: HttpServer = transportSecurity.secure
    ? createHttpsServer({
        cert: await readFile(transportSecurity.tlsCert),
        key: await readFile(transportSecurity.tlsKey),
      }, requestHandler)
    : createServer(requestHandler)
  // The largest protocol frame is the Wither payload; reject larger frames before decoding or queuing commands.
  const sockets = new WebSocketServer({ noServer: true, maxPayload: WITHER_MAX_WIRE_LENGTH })
  const activePlayers = new Map<string, string>()
  const reservedPlayers = new Set<string>()
  const MAX_PENDING_MULTIPLAYER_FRAMES = 64
  const MAX_PENDING_MULTIPLAYER_BYTES = 8 * 1024 * 1024

  server.on('upgrade', (request, socket, head) => {
    if (!isAllowedWebSocketOrigin(request.headers.origin, transportSecurity)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const path = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname
    if (path !== '/ws') {
      socket.destroy()
      return
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) => sockets.emit('connection', webSocket, request))
  })

  sockets.on('connection', (socket) => {
    const clientId = randomUUID()
    let disconnected = false
    let authenticatedPlayer: PlayerId | undefined
    let activePlayer: PlayerId | undefined
    let _messageQueue = Promise.resolve()
    let pendingFrameCount = 0
    let pendingFrameBytes = 0
    const disconnect = (): void => {
      if (disconnected) return
      disconnected = true
      if (authenticatedPlayer !== undefined) reservedPlayers.delete(authenticatedPlayer)
      if (activePlayer !== undefined && activePlayers.get(activePlayer) === clientId) {
        activePlayers.delete(activePlayer)
      }
      activeRealms.delete(clientId)
      for (const [worldId, core] of [
        [options.worldId, overworldCore],
        ['nether', netherCore],
        ['end', endCore],
      ] as const) {
        const result = core.disconnect(clientId)
        if (Result.isFailure(result)) console.error('Multiplayer disconnect failed', { clientId, worldId, failure: result.failure })
      }
    }
    const rejectHandshake = (reason: string = 'reconnect authentication failed'): void => {
      if (socket.readyState === WebSocket.OPEN) socket.close(1008, reason)
    }
    const rejectProtocolFrame = (): void => {
      if (socket.readyState === WebSocket.OPEN) socket.close(1008, 'invalid multiplayer frame')
    }
    const authenticate = async (resume: PlayerResume): Promise<void> => {
      const player = resume.player
      if (activePlayers.has(player) || reservedPlayers.has(player)) {
        rejectHandshake('player id already connected')
        return
      }
      reservedPlayers.add(player)
      try {
        let token: string | undefined
        const verifiedLegacyRegistration = resume.token === undefined
          && resume.registrationToken !== undefined
          && legacyPlayerClaims?.has(player) === true
          && legacyPlayerClaims.verify(player, resume.registrationToken)
        if (reconnectAuth.has(player)) {
          // A tokenless resume of an already-known id reaches this branch only once the
          // concurrency guard above has confirmed nobody else currently holds this id (an
          // active connection or another handshake already in flight would have rejected
          // above). A lost or never-received token is the ordinary case here — a new
          // device, a private window, cleared site storage, or the join form used twice —
          // and it is indistinguishable at the protocol level from a first-ever join,
          // which itself requires no proof. So it is granted the same way: a fresh token,
          // no proof required, same as claiming a brand-new name. This intentionally does
          // NOT protect a name against being reclaimed by someone else who knows it while
          // its owner is offline; that protection was never real for ordinary players (the
          // original claim never required proof either) and building real ownership would
          // need a durable credential (a password), which is the legacyPlayerClaims path
          // below already provides for names that carry pre-existing persisted state.
          token = resume.token === undefined
            ? await reconnectAuth.reissue(player)
            : await reconnectAuth.rotate(player, resume.token)
        } else if (legacyPlayers.has(player)) {
          // Unlike the branch above, this id has pre-existing persisted state (inventory,
          // vitals, position) from before this id ever had a reconnect token, and has not
          // yet been bridged into reconnectAuth. Claiming it for the first time still
          // requires the legacy registration secret — without that requirement, anyone who
          // knew or guessed a pre-existing player's name could claim their saved inventory
          // outright.
          token = verifiedLegacyRegistration ? await reconnectAuth.issue(player) : undefined
        } else {
          token = await reconnectAuth.issue(player)
        }
        if (token === undefined || disconnected) {
          reservedPlayers.delete(player)
          rejectHandshake(
            legacyPlayers.has(player)
              ? 'legacy player registration required'
              : 'reconnect authentication failed',
          )
          return
        }
        authenticatedPlayer = player
        socket.send(encodePlayerResumeAccepted(player, token))
      } catch {
        reservedPlayers.delete(player)
        rejectHandshake('reconnect authentication error')
      }
    }
    const send = (frame: WireText): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame)
    }
    overworldCore.connect(clientId, send)
    netherCore.connect(clientId, send)
    endCore.connect(clientId, send)
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        rejectProtocolFrame()
        return
      }
      const frame = data.toString()
      const frameBytes = Buffer.byteLength(frame, 'utf8')
      if (pendingFrameCount >= MAX_PENDING_MULTIPLAYER_FRAMES
        || pendingFrameBytes + frameBytes > MAX_PENDING_MULTIPLAYER_BYTES) {
        disconnect()
        rejectProtocolFrame()
        return
      }
      pendingFrameCount += 1
      pendingFrameBytes += frameBytes
      _messageQueue = _messageQueue.then(async () => {
        if (disconnected || persistenceFailed) return
        if (activePlayer !== undefined) {
          const realm = activeRealms.get(clientId)
          if (realm === undefined) {
            if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'multiplayer realm unavailable')
            return
          }
          const result = realm.receive(clientId, frame)
          if (!result.accepted && result.failure !== undefined) {
            console.error('Multiplayer command failed', { clientId, failure: result.failure })
          }
          if (result.accepted && result.message._tag === 'PlayerLeave') {
            disconnect()
            if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'player left')
            return
          }
          if (
            !result.accepted
            && (
              result.reason === 'unknown-client'
              || result.reason === 'malformed-frame'
              || result.reason === 'join-required'
              || result.reason === 'duplicate-player'
              || result.reason === 'identity-spoof'
            )
          ) rejectProtocolFrame()
          return
        }
        if (authenticatedPlayer === undefined) {
          const resume = decodePlayerResume(frame)
          if (resume === undefined) {
            rejectHandshake('malformed resume request')
            return
          }
          await authenticate(resume)
          return
        }
        const decoded = decodeFrame(frame)
        if (
          Result.isFailure(decoded)
          || decoded.success._tag !== 'PlayerJoin'
          || decoded.success.player !== authenticatedPlayer
        ) {
          reservedPlayers.delete(authenticatedPlayer)
          rejectHandshake('player join did not match authenticated identity')
          return
        }
        const result = overworldCore.receive(clientId, frame)
        if (!result.accepted) {
          reservedPlayers.delete(authenticatedPlayer)
          rejectHandshake('player join rejected')
          return
        }
        activePlayer = authenticatedPlayer
        activePlayers.set(activePlayer, clientId)
        activeRealms.set(clientId, overworldCore)
        reservedPlayers.delete(activePlayer)
      }).catch(() => rejectHandshake()).finally(() => {
        pendingFrameCount -= 1
        pendingFrameBytes -= frameBytes
      })
    })
    socket.once('close', disconnect)
    socket.once('error', disconnect)
  })

  const port = await listen(server, options.port, options.host)
  let lastTickAt = performance.now()
  let pendingServerTick: Promise<void> = Promise.resolve()
  const serverTickTimer = setInterval(() => {
    const now = performance.now()
    const elapsedMs = now - lastTickAt
    lastTickAt = now
    pendingServerTick = pendingServerTick.then(async () => {
      if (persistenceFailed) return
      const redstoneResult = await Effect.runPromise(redstoneRuntime.tick(elapsedMs))
      if (persistenceFailed) return
      if (Result.isFailure(redstoneResult)) {
        console.error('Multiplayer redstone tick failed', { failure: redstoneResult.failure })
      }
      for (const [worldId, core] of [
        [options.worldId, overworldCore],
        ['nether', netherCore],
        ['end', endCore],
      ] as const) {
        const result = core.tick(elapsedMs)
        if (Result.isFailure(result)) {
          console.error('Multiplayer tick failed', { worldId, failure: result.failure })
        } else {
          for (const refusal of result.success.refusals) console.error('Multiplayer tick refused a position', { worldId, refusal })
        }
      }
    }).catch((failure: unknown) => {
      console.error('Multiplayer server tick failed', { failure })
    })
  }, 50)
  let closing: Promise<void> | undefined
  const signalHandlers = new Map<NodeJS.Signals, () => void>()
  function close(): Promise<void> {
    if (closing !== undefined) return closing
    closing = new Promise<void>((resolve, reject) => {
      clearInterval(serverTickTimer)
      for (const [signal, handler] of signalHandlers) process.off(signal, handler)
      for (const socket of sockets.clients) socket.close(1001, 'server shutting down')
      sockets.close()
      server.close((error) => error === undefined ? resolve() : reject(error))
    }).then(async () => {
      await pendingServerTick
      await Promise.all([persistence?.drain(), netherPersistence?.drain(), endPersistence?.drain()])
    })
    return closing
  }

  if (options.installSignalHandlers === true) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = (): void => {
        void close().then(() => process.exit(0), () => process.exit(1))
      }
      signalHandlers.set(signal, handler)
      process.once(signal, handler)
    }
  }

  return Result.succeed({ host: options.host, port, close })
}

const entryPoint = process.argv[1]
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  const options = resolveMultiplayerRuntimeOptions()
  const runtime = await startMultiplayerServer(options)
  if (Result.isFailure(runtime)) {
    console.error('Multiplayer server startup failed', { failure: runtime.failure })
    process.exitCode = 1
  } else {
    const scheme = options.tlsCert === undefined ? 'ws' : 'wss'
    process.stdout.write(`multiplayer server listening on ${scheme}://${runtime.success.host}:${String(runtime.success.port)}/ws\n`)
  }
}
