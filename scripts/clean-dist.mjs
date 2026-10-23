import { resolve } from "node:path"
import { rm } from "node:fs/promises"

const root = resolve(import.meta.dirname, "..")

await rm(resolve(root, "dist"), { force: true, recursive: true })
