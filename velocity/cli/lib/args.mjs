// Tiny dependency-free flag parser. Deliberately not using a library here: the
// surface this CLI needs (--flag value / --flag=value / boolean --flag / positionals)
// is small enough that a real parser would be more code to configure than to write.

/**
 * @param {string[]} argv
 * @returns {{ positionals: string[], flags: Record<string, string | boolean> }}
 */
export function parseArgs(argv) {
  const positionals = []
  const flags = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }

    if (arg.startsWith('--')) {
      const body = arg.slice(2)
      const eqIndex = body.indexOf('=')
      if (eqIndex !== -1) {
        flags[body.slice(0, eqIndex)] = body.slice(eqIndex + 1)
        continue
      }

      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next
        i += 1
      } else {
        flags[body] = true
      }
      continue
    }

    if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true
      continue
    }

    positionals.push(arg)
  }

  return { positionals, flags }
}

export function flagAsInt(flags, name, fallback) {
  if (!(name in flags)) return fallback
  const value = flags[name]
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : NaN
  if (Number.isNaN(parsed)) {
    throw new Error(`--${name} expects a number, got: ${JSON.stringify(value)}`)
  }
  return parsed
}

export function flagAsBool(flags, name, fallback = false) {
  if (!(name in flags)) return fallback
  const value = flags[name]
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new Error(`--${name} expects a boolean, got: ${JSON.stringify(value)}`)
}

export function flagAsString(flags, name, fallback) {
  if (!(name in flags)) return fallback
  const value = flags[name]
  return typeof value === 'boolean' ? fallback : value
}
