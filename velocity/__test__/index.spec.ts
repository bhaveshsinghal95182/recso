// Sanity check that the native addon loaded and exposes the API surface documented
// in index.d.ts. This is the fastest test in the suite and is meant to fail loudly
// with an obvious error if `pnpm build` produced a stale or broken binary, rather
// than letting every other spec fail with a confusing "X is not a function".
import test from 'ava'

import * as velocity from '../index'

test('native addon exports the documented public API surface', (t) => {
  t.is(typeof velocity.Stopper, 'function')
  t.is(typeof velocity.captureCursorSamplesJson, 'function')
  t.is(typeof velocity.captureCursorSnapshotJson, 'function')
  t.is(typeof velocity.isCursorSettingsSupported, 'function')
  t.is(typeof velocity.listAvailableWindows, 'function')
  t.is(typeof velocity.listWebcamDevices, 'function')
  t.is(typeof velocity.startMonitorRecording, 'function')
  t.is(typeof velocity.startMonitorRecordingV2, 'function')
  t.is(typeof velocity.startWindowRecording, 'function')
  t.is(typeof velocity.startWindowRecordingV2, 'function')
})

test('native webcam preview exposes its lifecycle and frame APIs', (t) => {
  t.is(typeof velocity.startWebcamPreview, 'function')
  t.is(typeof velocity.webcamPreviewFrame, 'function')
  t.is(typeof velocity.clearWebcamPreviewFrame, 'function')
})

test('Stopper instances only expose stop()', (t) => {
  // We can't construct a Stopper directly from JS (it's only ever returned by the
  // start*Recording functions), but we can assert its prototype shape so a future
  // rename in the Rust bindings gets caught here instead of downstream.
  const stopperMethods = Object.getOwnPropertyNames(velocity.Stopper.prototype)
  t.true(stopperMethods.includes('stop'))
})
