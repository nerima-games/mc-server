import { Option, Schema } from 'effect'

const decodeJson = Schema.decodeUnknownOption(Schema.parseJson())

export const parseWireJson = (wire: string): unknown | undefined =>
  Option.getOrUndefined(decodeJson(wire))
