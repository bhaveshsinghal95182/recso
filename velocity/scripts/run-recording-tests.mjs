#!/usr/bin/env node
// Runs the ava suite with the opt-in recording integration tests enabled.
// A tiny spawn wrapper rather than `cross-env` so this stays dependency-free while
// still working identically on Windows (where `VAR=1 cmd` is not valid shell syntax).

import { spawn } from 'node:child_process'

const child = spawn('ava', process.argv.slice(2), {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, VELOCITY_RUN_RECORDING_TESTS: '1' },
})

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1))
})
