// Integration tests that drive the real Windows Graphics Capture / WASAPI / webcam
// pipeline end-to-end: they write actual .mp4 files to a temp dir and, for window
// recording, briefly steal foreground focus. They're skipped by default (see
// helpers/env.ts) so `pnpm test` stays fast and side-effect-free; run them explicitly
// with `pnpm test:recording` (or `VELOCITY_RUN_RECORDING_TESTS=1` set some other way)
// when you actually want to exercise real capture on this machine.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import test from 'ava'

import {
  listAvailableWindows,
  listWebcamDevices,
  startMonitorRecording,
  startMonitorRecordingV2,
  startWindowRecording,
} from '../index'
import { cleanupDir, makeTmpDir, shouldRunRecordingTests, wait } from './helpers/env'

const RECORD_MS = 900
const STOP_SETTLE_MS = 400
const LOW_BITRATE = 2_000_000

// Selecting the runner up front means ava reports these as genuinely skipped rather
// than as passing assertions, so a default `pnpm test` run can't be mistaken for
// evidence that real capture works.
const recordingTest = shouldRunRecordingTests() ? test.serial : test.serial.skip

recordingTest('startMonitorRecording (v1) writes a non-empty mp4 and Stopper.stop() finalizes it', async (t) => {
  const dir = await makeTmpDir('velocity-monitor-v1-')
  const outputPath = path.join(dir, 'monitor.mp4')

  try {
    const stopper = startMonitorRecording(outputPath, LOW_BITRATE, false)
    await wait(RECORD_MS)
    stopper.stop()
    await wait(STOP_SETTLE_MS)

    t.true(fs.existsSync(outputPath), 'expected the recording file to exist after stop()')
    t.true(fs.statSync(outputPath).size > 0, 'expected the recording file to contain data')
  } finally {
    await cleanupDir(dir)
  }
})

recordingTest('startMonitorRecordingV2 writes a non-empty mp4 at targetFps 30', async (t) => {
  const dir = await makeTmpDir('velocity-monitor-v2-')
  const outputPath = path.join(dir, 'monitor.mp4')

  try {
    const stopper = startMonitorRecordingV2({
      outputPath,
      bitrate: LOW_BITRATE,
      includeSystemAudio: false,
      targetFps: 30,
    })
    await wait(RECORD_MS)
    stopper.stop()
    await wait(STOP_SETTLE_MS)

    t.true(fs.existsSync(outputPath))
    t.true(fs.statSync(outputPath).size > 0)
  } finally {
    await cleanupDir(dir)
  }
})

// KNOWN FAILING: enabling system audio currently produces an 80-byte (header-only)
// mp4, and Stopper.stop() blocks for its full 8s timeout because the capture thread
// never signals completion. Reproduces on both the v1 and v2 entry points and at both
// 30 and 60 fps, so it's in the shared audio path (Capture::initialize_encoder /
// send_frame_with_audio in desktop_capture.rs), not in the v2 options plumbing.
// This test is written to assert the *correct* behavior so it goes green once fixed.
recordingTest('startMonitorRecordingV2 writes a non-empty mp4 with system audio enabled', async (t) => {
  const dir = await makeTmpDir('velocity-monitor-audio-')
  const outputPath = path.join(dir, 'monitor.mp4')

  try {
    const stopper = startMonitorRecordingV2({
      outputPath,
      bitrate: LOW_BITRATE,
      includeSystemAudio: true,
      targetFps: 30,
    })
    await wait(RECORD_MS)

    const stopStartedAt = Date.now()
    stopper.stop()
    const stopBlockedMs = Date.now() - stopStartedAt
    await wait(STOP_SETTLE_MS)

    t.true(
      stopBlockedMs < 5000,
      `stop() should return promptly, but blocked for ${stopBlockedMs}ms (capture thread never signalled done)`,
    )
    t.true(fs.existsSync(outputPath))
    t.true(
      fs.statSync(outputPath).size > 1024,
      `expected a real recording, got ${fs.statSync(outputPath).size} bytes (header-only mp4)`,
    )
  } finally {
    await cleanupDir(dir)
  }
})

recordingTest('startMonitorRecordingV2 rejects an unknown webcamDeviceId instead of silently ignoring it', (t) => {
  t.throws(() => {
    startMonitorRecordingV2({
      outputPath: path.join(os.tmpdir(), 'velocity-should-not-be-created.mp4'),
      bitrate: LOW_BITRATE,
      enableWebcam: true,
      webcamDeviceId: 'definitely-not-a-real-device-id',
    })
  })
})

recordingTest('startWindowRecording records the first available window, when one exists', async (t) => {
  const windows = listAvailableWindows()
  if (windows.length === 0) {
    t.pass('no capturable windows are available on this machine right now')
    return
  }

  const dir = await makeTmpDir('velocity-window-')
  const outputPath = path.join(dir, 'window.mp4')

  try {
    const stopper = startWindowRecording(windows[0].title, outputPath, LOW_BITRATE, false)
    await wait(RECORD_MS)
    stopper.stop()
    await wait(STOP_SETTLE_MS)

    t.true(fs.existsSync(outputPath))
    t.true(fs.statSync(outputPath).size > 0)
  } finally {
    await cleanupDir(dir)
  }
})

recordingTest('startWindowRecording rejects a window title that does not exist', (t) => {
  t.throws(() => {
    startWindowRecording('___velocity-nonexistent-window-title___', 'unused.mp4', LOW_BITRATE, false)
  })
})

recordingTest('enabling webcam without any camera attached surfaces a clear synchronous error', async (t) => {
  if (listWebcamDevices().length > 0) {
    t.pass('a webcam is attached on this machine; cannot exercise the no-camera error path')
    return
  }

  const dir = await makeTmpDir('velocity-nocam-')
  const outputPath = path.join(dir, 'monitor.mp4')

  try {
    // On webcam startup failure, start_monitor_recording_v2 must also tear down the
    // desktop capture side it had already started rather than leaving it running
    // detached and unreachable (see attach_webcam_stopper_if_requested in capture.rs).
    t.throws(() => {
      startMonitorRecordingV2({
        outputPath,
        bitrate: LOW_BITRATE,
        enableWebcam: true,
      })
    })
  } finally {
    await cleanupDir(dir)
  }
})
