import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"

const SUCCESS_EXIT_STATUS = 0
const root = process.cwd()
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const temporaryDirectory = mkdtempSync(join(tmpdir(), "mc-server-package-"))

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000
  })
  if (result.error || result.status !== SUCCESS_EXIT_STATUS) {
    const reason = result.error?.message ?? (result.stderr?.trim() || `exit status ${String(result.status)}`)
    throw new Error(`${command} ${args.join(" ")} failed: ${reason}`)
  }
  return result.stdout
}

try {
  const runtime = await import(pathToFileURL(join(root, "dist/src/index.js")).href)
  if (runtime.serverPackageName !== packageJson.name) {
    throw new Error("dist/src/index.js does not expose the package identifier")
  }

  const shared = await import("@nerima-games/mc-server/shared")
  if (typeof shared.isValidAnvilName !== "function") {
    throw new Error("the shared package subpath does not expose isValidAnvilName")
  }

  const server = await import(pathToFileURL(join(root, "dist/apps/multiplayer-server/main.js")).href)
  if (typeof server.startMultiplayerServer !== "function") {
    throw new Error("the server entry does not expose startMultiplayerServer")
  }

  const cliPath = join(root, packageJson.bin["mc-server"])
  const cliSource = readFileSync(cliPath, "utf8")
  if (!cliSource.startsWith("#!/usr/bin/env node\n")) {
    throw new Error("the mc-server bin entry is missing its Node shebang")
  }
  const invalidOptions = spawnSync(process.execPath, [cliPath, "--port=invalid"], { encoding: "utf8", timeout: 10_000 })
  if (
    invalidOptions.error ||
    invalidOptions.status === SUCCESS_EXIT_STATUS ||
    !invalidOptions.stderr.includes("port must be an integer")
  ) {
    throw new Error("the mc-server bin entry did not reject an invalid port")
  }

  run("pnpm", ["pack", "--pack-destination", temporaryDirectory, "--silent"])
  const archiveName = readdirSync(temporaryDirectory).find((name) => name.endsWith(".tgz"))
  if (!archiveName) {
    throw new Error("pnpm pack produced no archive")
  }

  const archive = join(temporaryDirectory, archiveName)
  const entries = new Set(run("tar", ["-tzf", archive]).split("\n").filter(Boolean))
  for (const entry of [
    "package/dist/src/index.js",
    "package/dist/src/index.d.ts",
    "package/dist/apps/multiplayer-shared/index.js",
    "package/dist/apps/multiplayer-shared/index.d.ts",
    "package/dist/apps/multiplayer-server/main.js",
    "package/README.md",
    "package/LICENSE"
  ]) {
    if (!entries.has(entry)) {
      throw new Error(`package archive is missing ${entry}`)
    }
  }
  if ([...entries].some((entry) => entry.startsWith("package/src/"))) {
    throw new Error("package archive contains source files")
  }
  process.stdout.write(`verified ${packageJson.name} archive ${archiveName}\n`)
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
