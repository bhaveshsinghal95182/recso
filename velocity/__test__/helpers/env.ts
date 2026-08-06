// Shared helpers for the ava test suite. Not a test file itself (doesn't match
// ava's `*.spec.ts` glob), so it is safe to import from any spec.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Recording/webcam tests exercise the real Windows Graphics Capture APIs: they write
 * actual video files, may briefly steal foreground focus (window recording) and, with
 * `--webcam`, touch physical camera hardware. That's exactly what you want when
 * validating a change by hand, but it's the wrong default for `pnpm test` in CI or a
 * quick inner-dev-loop run. These tests are skipped unless explicitly opted into.
 */
export function shouldRunRecordingTests(): boolean {
  return process.env.VELOCITY_RUN_RECORDING_TESTS === '1'
}

export async function makeTmpDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix))
}

export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
