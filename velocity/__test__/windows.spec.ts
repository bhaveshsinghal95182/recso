import test from 'ava'

import { listAvailableWindows } from '../index'

test('listAvailableWindows returns an array of well-formed WindowInfo objects', (t) => {
  const windows = listAvailableWindows()
  t.true(Array.isArray(windows))

  for (const win of windows) {
    t.is(typeof win.title, 'string')
    t.true(win.title.length > 0, 'enumerate() already filters out windows with an empty title')

    t.is(typeof win.className, 'string')
    t.is(typeof win.x, 'number')
    t.is(typeof win.y, 'number')

    t.is(typeof win.width, 'number')
    t.is(typeof win.height, 'number')
    t.true(win.width > 0)
    t.true(win.height > 0)

    if (win.thumbnailDataUrl !== undefined && win.thumbnailDataUrl !== null) {
      t.true(win.thumbnailDataUrl.startsWith('data:image/jpeg;base64,'))
    }
  }
})

test('listAvailableWindows excludes known system helper window classes', (t) => {
  const windows = listAvailableWindows()
  const blockedClasses = new Set(['Windows.UI.Core.CoreWindow', 'WorkerW', 'Progman'])

  for (const win of windows) {
    t.false(blockedClasses.has(win.className), `${win.className} should have been filtered out`)
  }
})

test('listAvailableWindows does not report the same window geometry twice', (t) => {
  // Guards against an enumeration regression that walks the same HWND twice.
  const windows = listAvailableWindows()
  const seen = new Set<string>()

  for (const win of windows) {
    const key = `${win.title}|${win.className}|${win.x}|${win.y}|${win.width}|${win.height}`
    t.false(seen.has(key), `duplicate window entry: ${key}`)
    seen.add(key)
  }
})

test('listAvailableWindows is stable enough to call repeatedly without throwing', (t) => {
  t.notThrows(() => {
    for (let i = 0; i < 3; i += 1) {
      listAvailableWindows()
    }
  })
})
