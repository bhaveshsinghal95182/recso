#!/usr/bin/env node
// Automated end-to-end smoke test for the velocity native addon.
//
// Unlike the ava suite (which asserts on API shape and pure logic), this drives the
// real capture pipeline and verifies that actual bytes land on disk. It's the thing
// to run after a Rust change to answer "does recording still work on this machine?"
// in ~20 seconds, and it exits non-zero on the first hard failure so it can gate CI.
//
//   node cli/smoke.mjs                 # core checks + monitor recording
//   node cli/smoke.mjs --webcam        # also exercise the webcam sidecar
//   node cli/smoke.mjs --window        # also record the first available window
//   node cli/smoke.mjs --json          # machine-readable results
//   node cli/smoke.mjs --keep          # don't delete the recordings it produces

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { flagAsBool, parseArgs } from './lib/args.mjs'
import { dim, fail, formatBytes, formatMs, heading, ok, warn } from './lib/format.mjs'
import { loadVelocity } from './lib/native.mjs'

const RECORD_MS = 2500
const STOP_SETTLE_MS = 500
const BITRATE = 4_000_000
const MIN_PLAUSIBLE_BYTES = 1024

const { flags } = parseArgs(process.argv.slice(2))
const asJson = flagAsBool(flags, 'json')
const keepArtifacts = flagAsBool(flags, 'keep')
const includeWebcam = flagAsBool(flags, 'webcam')
const includeWindow = flagAsBool(flags, 'window')

const results = []

function record(name, status, detail) {
  results.push({ name, status, detail })
  if (asJson) return

  const badge =
    status === 'pass' ? ok('PASS') : status === 'skip' ? dim('SKIP') : status === 'warn' ? warn('WARN') : fail('FAIL')
  console.log(`  ${badge}  ${name}${detail ? dim(` — ${detail}`) : ''}`)
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Runs a check, recording pass/fail instead of letting an exception escape. */
function check(name, fn) {
  try {
    const detail = fn()
    record(name, 'pass', detail)
    return true
  } catch (error) {
    record(name, 'fail', error instanceof Error ? error.message : String(error))
    return false
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn()
    record(name, 'pass', detail)
    return true
  } catch (error) {
    record(name, 'fail', error instanceof Error ? error.message : String(error))
    return false
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function recordAndVerify(label, workDir, start) {
  const outputPath = path.join(workDir, `${label}.mp4`)
  const startedAt = Date.now()

  const stopper = start(outputPath)
  await wait(RECORD_MS)

  // A healthy stop() returns in well under a second. Stopper::stop waits up to 8s per
  // channel for the capture thread to signal done, so a multi-second block here means
  // the capture thread wedged — worth reporting separately from an empty output file.
  const stopStartedAt = Date.now()
  stopper.stop()
  const stopBlockedMs = Date.now() - stopStartedAt
  await wait(STOP_SETTLE_MS)

  assert(
    stopBlockedMs < 5000,
    `stop() blocked for ${formatMs(stopBlockedMs)} — the capture thread never signalled completion`,
  )
  assert(fs.existsSync(outputPath), `no output file was produced at ${outputPath}`)
  const size = fs.statSync(outputPath).size
  assert(size >= MIN_PLAUSIBLE_BYTES, `output file is implausibly small (${size} bytes)`)

  return { outputPath, size, stopBlockedMs, elapsedMs: Date.now() - startedAt }
}

async function main() {
  const startedAt = Date.now()
  if (!asJson) console.log(heading('\nVelocity smoke test\n'))

  const velocity = loadVelocity()
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velocity-smoke-'))

  try {
    // --- Enumeration / read-only APIs -------------------------------------
    check('native addon exposes the expected API surface', () => {
      for (const name of [
        'captureCursorSamplesJson',
        'captureCursorSnapshotJson',
        'isCursorSettingsSupported',
        'listAvailableWindows',
        'listWebcamDevices',
        'startMonitorRecording',
        'startMonitorRecordingV2',
        'startWindowRecording',
        'startWindowRecordingV2',
      ]) {
        assert(typeof velocity[name] === 'function', `${name} is not exported as a function`)
      }
      return '9 exports'
    })

    check('isCursorSettingsSupported returns a boolean', () => {
      const supported = velocity.isCursorSettingsSupported()
      assert(typeof supported === 'boolean', `expected boolean, got ${typeof supported}`)
      return String(supported)
    })

    let windows = []
    check('listAvailableWindows returns well-formed entries', () => {
      windows = velocity.listAvailableWindows()
      assert(Array.isArray(windows), 'expected an array')
      for (const win of windows) {
        assert(typeof win.title === 'string' && win.title.length > 0, 'window has an empty title')
        assert(win.width > 0 && win.height > 0, `window "${win.title}" has non-positive dimensions`)
      }
      return `${windows.length} window(s)`
    })

    let webcams = []
    check('listWebcamDevices returns well-formed entries', () => {
      webcams = velocity.listWebcamDevices()
      assert(Array.isArray(webcams), 'expected an array')
      const ids = webcams.map((device) => device.id)
      assert(new Set(ids).size === ids.length, 'duplicate webcam device ids')
      return `${webcams.length} device(s)`
    })

    check('captureCursorSnapshotJson returns a parseable snapshot', () => {
      const snapshot = JSON.parse(velocity.captureCursorSnapshotJson())
      assert(typeof snapshot.capturedAtEpochMs === 'number', 'missing capturedAtEpochMs')
      assert(snapshot.cursorInfo, 'missing cursorInfo')
      assert(snapshot.windowUnderCursor, 'missing windowUnderCursor')
      return snapshot.cursorInfo.systemCursorGuess ?? 'custom cursor'
    })

    check('captureCursorSamplesJson clamps and collects samples', () => {
      const payload = JSON.parse(velocity.captureCursorSamplesJson(5, 0))
      assert(payload.durationMs === 20, `duration should clamp to 20, got ${payload.durationMs}`)
      assert(payload.intervalMs === 1, `interval should clamp to 1, got ${payload.intervalMs}`)
      assert(payload.samples.length === payload.sampleCount, 'sampleCount disagrees with samples.length')
      return `${payload.sampleCount} sample(s)`
    })

    // --- Real capture -----------------------------------------------------
    await checkAsync('startMonitorRecording (v1) writes a non-empty mp4', async () => {
      const { size, elapsedMs } = await recordAndVerify('monitor-v1', workDir, (outputPath) =>
        velocity.startMonitorRecording(outputPath, BITRATE, false),
      )
      return `${formatBytes(size)} in ${formatMs(elapsedMs)}`
    })

    await checkAsync('startMonitorRecordingV2 writes a non-empty mp4 at 30fps', async () => {
      const { size, elapsedMs } = await recordAndVerify('monitor-v2', workDir, (outputPath) =>
        velocity.startMonitorRecordingV2({
          outputPath,
          bitrate: BITRATE,
          includeSystemAudio: false,
          targetFps: 30,
        }),
      )
      return `${formatBytes(size)} in ${formatMs(elapsedMs)}`
    })

    // Kept as its own check (rather than folded into the video-only one) so a failure
    // points at the audio path specifically instead of making all of v2 look broken.
    // This is the regression guard for the windows-capture 1.5.0 deadlock, where
    // send_frame_with_audio waited on a condvar the sample-requested handler could not
    // signal. --no-audio skips it on machines with no usable render endpoint.
    if (flagAsBool(flags, 'no-audio')) {
      record('startMonitorRecordingV2 writes a non-empty mp4 with system audio', 'skip', '--no-audio passed')
    } else {
      await checkAsync('startMonitorRecordingV2 writes a non-empty mp4 with system audio', async () => {
        const { size, elapsedMs } = await recordAndVerify('monitor-audio', workDir, (outputPath) =>
          velocity.startMonitorRecordingV2({
            outputPath,
            bitrate: BITRATE,
            includeSystemAudio: true,
            targetFps: 30,
          }),
        )
        return `${formatBytes(size)} in ${formatMs(elapsedMs)}`
      })
    }

    check('startMonitorRecordingV2 rejects an unknown webcamDeviceId', () => {
      let threw = false
      try {
        velocity
          .startMonitorRecordingV2({
            outputPath: path.join(workDir, 'should-not-exist.mp4'),
            bitrate: BITRATE,
            enableWebcam: true,
            webcamDeviceId: '__not-a-real-device__',
          })
          .stop()
      } catch {
        threw = true
      }
      assert(threw, 'expected a thrown error for an unknown webcam device id')
      return 'threw as expected'
    })

    check('startWindowRecording rejects an unknown window title', () => {
      let threw = false
      try {
        velocity.startWindowRecording('__not-a-real-window__', path.join(workDir, 'nope.mp4'), BITRATE, false).stop()
      } catch {
        threw = true
      }
      assert(threw, 'expected a thrown error for an unknown window title')
      return 'threw as expected'
    })

    if (includeWindow) {
      if (windows.length === 0) {
        record('startWindowRecording writes a non-empty mp4', 'skip', 'no capturable windows available')
      } else {
        await checkAsync('startWindowRecording writes a non-empty mp4', async () => {
          const { size } = await recordAndVerify('window', workDir, (outputPath) =>
            velocity.startWindowRecording(windows[0].title, outputPath, BITRATE, false),
          )
          return `"${windows[0].title}" -> ${formatBytes(size)}`
        })
      }
    } else {
      record('startWindowRecording writes a non-empty mp4', 'skip', 'pass --window to enable (steals focus)')
    }

    if (includeWebcam) {
      if (webcams.length === 0) {
        record('webcam sidecar recording produces a _camera.mp4', 'skip', 'no webcam attached')
      } else {
        await checkAsync('webcam sidecar recording produces a _camera.mp4', async () => {
          const { outputPath, size } = await recordAndVerify('monitor-webcam', workDir, (out) =>
            velocity.startMonitorRecordingV2({
              outputPath: out,
              bitrate: BITRATE,
              targetFps: 30,
              enableWebcam: true,
              webcamDeviceId: webcams[0].id,
            }),
          )

          const sidecarPath = outputPath.replace(/\.mp4$/i, '_camera.mp4')
          assert(fs.existsSync(sidecarPath), `expected a webcam sidecar at ${sidecarPath}`)
          const sidecarSize = fs.statSync(sidecarPath).size
          assert(sidecarSize >= MIN_PLAUSIBLE_BYTES, `webcam sidecar is implausibly small (${sidecarSize} bytes)`)

          return `desktop ${formatBytes(size)} + camera ${formatBytes(sidecarSize)}`
        })
      }
    } else {
      record('webcam sidecar recording produces a _camera.mp4', 'skip', 'pass --webcam to enable')
    }
  } finally {
    if (keepArtifacts) {
      if (!asJson) console.log(dim(`\nArtifacts kept in ${workDir}`))
    } else {
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  }

  const passed = results.filter((r) => r.status === 'pass').length
  const failed = results.filter((r) => r.status === 'fail').length
  const skipped = results.filter((r) => r.status === 'skip').length
  const elapsedMs = Date.now() - startedAt

  if (asJson) {
    console.log(JSON.stringify({ passed, failed, skipped, elapsedMs, results }, null, 2))
  } else {
    console.log(
      `\n${failed === 0 ? ok('All checks passed') : fail(`${failed} check(s) failed`)} ` +
        dim(`(${passed} passed, ${failed} failed, ${skipped} skipped in ${formatMs(elapsedMs)})\n`),
    )
  }

  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(fail('\nSmoke test crashed:'), error)
  process.exitCode = 1
})
