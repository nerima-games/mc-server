import { Option, Schema } from 'effect'

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export const parseWireJson = (wire: string): unknown | undefined =>
  Option.getOrUndefined(decodeJson(wire))
