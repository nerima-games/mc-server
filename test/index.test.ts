import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { serverPackageName } from "../src/index.js"
import { isValidAnvilName } from "../apps/multiplayer-shared/index.js"

describe("package entry points", () => {
  it("exports its name and shared helpers", () => {
    expect(serverPackageName).toBe("@nerima-games/mc-server")
    expect(isValidAnvilName("Hunter")).toBe(true)
    expect(isValidAnvilName("x".repeat(51))).toBe(false)
  })

  it("returns a boolean for arbitrary anvil names", () => {
    fc.assert(fc.property(fc.anything(), (value) => typeof isValidAnvilName(value) === "boolean"))
  })
})
