// Loads the compiled native addon (index.js, which in turn resolves the platform
// .node binary). Centralized here so every command gets the same "did you forget to
// build?" error message instead of a raw MODULE_NOT_FOUND stack trace.

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

let cached = null

export function loadVelocity() {
  if (cached) return cached

  try {
    cached = require(path.join(packageRoot, 'index.js'))
    return cached
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new CliError(
      `Failed to load the velocity native addon from ${path.join(packageRoot, 'index.js')}.\n` +
        `  Reason: ${reason}\n` +
        `  Did you run "pnpm build" (or "pnpm build:debug") first?`,
    )
  }
}

export class CliError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}
