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
  const runtime = await import(pathToFileURL(join(root, "dist/index.js")).href)
  if (runtime.serverPackageName !== packageJson.name) {
    throw new Error("dist/index.js does not expose the package identifier")
  }

  const cliPath = join(root, packageJson.bin["mc-server"])
  const cli = spawnSync(process.execPath, [cliPath], { encoding: "utf8", timeout: 10_000 })
  if (
    cli.status !== SUCCESS_EXIT_STATUS ||
    cli.stderr !== "The mc-server CLI is a placeholder and does not start a server.\n"
  ) {
    throw new Error("the CLI entry does not report its placeholder state")
  }

  run("pnpm", ["pack", "--pack-destination", temporaryDirectory, "--silent"])
  const archiveName = readdirSync(temporaryDirectory).find((name) => name.endsWith(".tgz"))
  if (!archiveName) {
    throw new Error("pnpm pack produced no archive")
  }

  const archive = join(temporaryDirectory, archiveName)
  const entries = new Set(run("tar", ["-tzf", archive]).split("\n").filter(Boolean))
  for (const entry of [
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/cli.js",
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
