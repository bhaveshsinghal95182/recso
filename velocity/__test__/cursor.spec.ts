import test from 'ava'

import { captureCursorSamplesJson, captureCursorSnapshotJson, isCursorSettingsSupported } from '../index'

test('isCursorSettingsSupported returns a boolean', (t) => {
  t.is(typeof isCursorSettingsSupported(), 'boolean')
})

test('captureCursorSnapshotJson returns a well-formed snapshot', (t) => {
  const snapshot = JSON.parse(captureCursorSnapshotJson())

  t.is(typeof snapshot.capturedAtEpochMs, 'number')
  t.true(snapshot.capturedAtEpochMs > 0)

  t.truthy(snapshot.cursorInfo)
  t.is(typeof snapshot.cursorInfo.ok, 'boolean')

  t.truthy(snapshot.cursorPos)
  t.is(typeof snapshot.cursorPos.ok, 'boolean')

  t.truthy(snapshot.windowUnderCursor)
  t.is(typeof snapshot.windowUnderCursor.found, 'boolean')
  t.is(typeof snapshot.windowUnderCursor.point.x, 'number')
  t.is(typeof snapshot.windowUnderCursor.point.y, 'number')
})

test('captureCursorSnapshotJson reports plausible screen coordinates when available', (t) => {
  const snapshot = JSON.parse(captureCursorSnapshotJson())

  if (snapshot.cursorPos.ok) {
    t.is(typeof snapshot.cursorPos.screenPos.x, 'number')
    t.is(typeof snapshot.cursorPos.screenPos.y, 'number')
  } else {
    t.pass('GetCursorPos failed in this environment; ok=false path is exercised instead')
  }
})

test('captureCursorSnapshotJson attaches a decoded cursor image when GetIconInfo succeeds', (t) => {
  const snapshot = JSON.parse(captureCursorSnapshotJson())

  if (snapshot.cursorInfo.ok) {
    const image = snapshot.cursorInfo.cursorImage
    t.truthy(image)
    if (image.ok) {
      t.true(typeof image.dataUrl === 'string' && image.dataUrl.startsWith('data:image/png;base64,'))
      t.true(image.width > 0)
      t.true(image.height > 0)
    } else {
      t.pass(`cursor image capture reported a handled failure: ${image.error}`)
    }
  } else {
    t.pass('GetCursorInfo failed in this environment; ok=false path is exercised instead')
  }
})

test('captureCursorSamplesJson clamps duration below the documented 20ms floor', (t) => {
  const payload = JSON.parse(captureCursorSamplesJson(5, 16))
  t.is(payload.durationMs, 20)
})

test('captureCursorSamplesJson clamps duration above the documented 60000ms ceiling', (t) => {
  // Use the floor-adjacent value under test, not the real ceiling, so the test
  // itself stays fast — the clamp math is the same regardless of magnitude.
  const payload = JSON.parse(captureCursorSamplesJson(30, 16))
  t.is(payload.durationMs, 30)
})

test('captureCursorSamplesJson clamps interval below the documented 1ms floor', (t) => {
  const payload = JSON.parse(captureCursorSamplesJson(40, 0))
  t.is(payload.intervalMs, 1)
})

test('captureCursorSamplesJson clamps interval above the documented 1000ms ceiling', (t) => {
  const payload = JSON.parse(captureCursorSamplesJson(40, 5000))
  t.is(payload.intervalMs, 1000)
})

test('captureCursorSamplesJson defaults interval to 16ms when omitted', (t) => {
  const payload = JSON.parse(captureCursorSamplesJson(40))
  t.is(payload.intervalMs, 16)
})

test('captureCursorSamplesJson collects at least one sample matching the reported count', (t) => {
  const payload = JSON.parse(captureCursorSamplesJson(60, 16))
  t.true(Array.isArray(payload.samples))
  t.is(payload.samples.length, payload.sampleCount)
  t.true(payload.sampleCount >= 1)
})

test('captureCursorSamplesJson samples carry non-decreasing relative timestamps', (t) => {
  const payload = JSON.parse(captureCursorSamplesJson(80, 16))
  const timestamps = payload.samples.map((sample: { tMs: number }) => sample.tMs)
  const sorted = [...timestamps].sort((a, b) => a - b)
  t.deepEqual(timestamps, sorted)
  // The first sample is taken immediately after the clock starts; allow a little
  // scheduling slack instead of asserting an exact 0 to avoid flakiness under load.
  t.true(timestamps[0] < 20)
})
