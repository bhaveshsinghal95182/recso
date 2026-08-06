import test from 'ava'

import { listWebcamDevices } from '../index'

test('listWebcamDevices returns an array of well-formed WebcamDeviceInfo objects', (t) => {
  const devices = listWebcamDevices()
  t.true(Array.isArray(devices))

  for (const device of devices) {
    t.is(typeof device.id, 'string')
    t.true(device.id.length > 0)
    t.is(typeof device.label, 'string')
    t.true(device.label.length > 0, 'empty human_name should fall back to "Camera N"')
    t.is(typeof device.isDefault, 'boolean')
  }
})

test('listWebcamDevices marks at most one device as default', (t) => {
  const devices = listWebcamDevices()
  const defaults = devices.filter((device) => device.isDefault)
  t.true(defaults.length <= 1)
})

test('listWebcamDevices marks the first enumerated device as default when any are present', (t) => {
  const devices = listWebcamDevices()
  if (devices.length > 0) {
    t.true(devices[0].isDefault)
    t.true(devices.slice(1).every((device) => !device.isDefault))
  } else {
    t.pass('no webcam devices attached to this machine')
  }
})

test('listWebcamDevices reports unique device ids', (t) => {
  const devices = listWebcamDevices()
  const ids = devices.map((device) => device.id)
  t.is(new Set(ids).size, ids.length)
})

test('listWebcamDevices does not throw when called repeatedly', (t) => {
  t.notThrows(() => {
    for (let i = 0; i < 3; i += 1) {
      listWebcamDevices()
    }
  })
})
