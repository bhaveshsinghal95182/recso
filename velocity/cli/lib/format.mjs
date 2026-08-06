// Minimal, dependency-light formatting helpers (chalk is the only extra dep, and
// it's already a devDependency of this package). Kept separate from command logic
// so commands stay focused on "what to call", not "how to print it".

import chalk from 'chalk'

export function heading(text) {
  return chalk.bold.cyan(text)
}

export function ok(text) {
  return chalk.green(text)
}

export function warn(text) {
  return chalk.yellow(text)
}

export function fail(text) {
  return chalk.red(text)
}

export function dim(text) {
  return chalk.dim(text)
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

export function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Renders an array of plain objects as a padded, aligned table.
 * `columns` is an ordered list of { key, label, format? }.
 */
export function renderTable(rows, columns) {
  if (rows.length === 0) return dim('(none)')

  const cellText = (row, column) => {
    const raw = row[column.key]
    const formatted = column.format ? column.format(raw, row) : String(raw ?? '')
    return formatted
  }

  const widths = columns.map((column) =>
    Math.max(column.label.length, ...rows.map((row) => stripAnsiLength(cellText(row, column)))),
  )

  const headerLine = columns.map((column, i) => chalk.bold(column.label.padEnd(widths[i]))).join('  ')
  const separatorLine = widths.map((width) => '-'.repeat(width)).join('  ')

  const bodyLines = rows.map((row) =>
    columns
      .map((column, i) => padAnsi(cellText(row, column), widths[i]))
      .join('  '),
  )

  return [headerLine, separatorLine, ...bodyLines].join('\n')
}

// Built via fromCharCode rather than a literal escape so the source carries no raw
// control character (which linters flag in regex literals).
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

function stripAnsiLength(text) {
  return text.replace(ANSI_PATTERN, '').length
}

function padAnsi(text, width) {
  const visibleLength = stripAnsiLength(text)
  return visibleLength >= width ? text : text + ' '.repeat(width - visibleLength)
}
