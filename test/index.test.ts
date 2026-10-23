import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import process from "node:process"
import { serverPackageName } from "../src/index.js"
import { vi } from "vitest"

const EXPECTED_CLI_WRITES = 1

describe("package entry points", () => {
  it.effect("exports its name and reports the CLI placeholder", () =>
    Effect.promise(async () => {
      const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
      try {
        await import("../src/cli.js")
        expect(serverPackageName).toBe("@nerima-games/mc-server")
        expect(stderrWrite).toHaveBeenCalledTimes(EXPECTED_CLI_WRITES)
        expect(stderrWrite).toHaveBeenCalledWith("The mc-server CLI is a placeholder and does not start a server.\n")
      } finally {
        stderrWrite.mockRestore()
      }
    }),
  )
})
