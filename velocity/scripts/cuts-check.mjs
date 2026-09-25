// Cuts, end to end: does removing a span actually shorten the edit, and does
// the playhead land on the right frame afterwards?
//
// Needs a source with a real duration, which a screen recording is not: capture
// only emits a frame when something changes, so an idle desktop produces a clip
// tens of milliseconds long. `PatternEncoder` writes a fixed number of frames at
// a fixed rate, which is the only way to get a predictable timeline to test
// against -- and is the reason it has not been deleted along with the rest of
// the prototype leftovers.
//
// usage: node velocity/scripts/cuts-check.mjs

import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const velocity = require(path.resolve(here, '..', 'index.js'))

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutscheck-'))
const clipPath = path.join(workDir, 'pattern.mp4')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

try {
  // 6 seconds at 30fps of the built-in test pattern.
  const FPS = 30
  const FRAMES = FPS * 6
  const encoder = new velocity.PatternEncoder(clipPath, 640, 360, FPS, 4_000_000)
  for (let i = 0; i < FRAMES; i += 1) encoder.writeFrame()
  encoder.finish()

  console.log('source')
  const probe = velocity.probeVideo(clipPath)
  check('pattern clip opens', probe.opened, probe.error)

  const player = velocity.VideoPlayer.open({ path: clipPath })
  const info = player.info()
  const sourceMs = info.duration
  console.log(`        ${info.width}x${info.height}, ${sourceMs.toFixed(0)}ms`)

  check('duration with no cuts is the file duration', Math.abs(player.compositionDuration() - sourceMs) < 1)

  // Remove the middle second.
  const CUT = { startMs: 2000, endMs: 3000 }
  player.setCuts([CUT])
  await sleep(400)

  check('cuts load', player.cutCount() === 1, `${player.cutCount()} cuts`)
  check(
    'the edit is shorter by exactly what was cut',
    Math.abs(player.compositionDuration() - (sourceMs - 1000)) < 1,
    `${player.compositionDuration().toFixed(0)}ms vs ${(sourceMs - 1000).toFixed(0)}ms`,
  )

  async function seekTo(ms) {
    player.seek(ms, true)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (player.tick()) break
      await sleep(2)
    }
    await sleep(200)
    return player.stats().currentTime
  }

  // Composition 1900 is before the cut, so it is source 1900 -- unchanged.
  const before = await seekTo(1900)
  check('before the cut the playhead is unmoved', Math.abs(before - 1900) < 120, `${before.toFixed(0)}ms`)

  // Composition 2100 is source 3100: past the removed second.
  const after = await seekTo(2100)
  check('after the cut the playhead stays in composition time', Math.abs(after - 2100) < 120, `${after.toFixed(0)}ms`)

  // Seeking past the shortened end clamps to the edit, not the file.
  const end = await seekTo(sourceMs)
  check(
    'seeking past the end clamps to the edit',
    end <= sourceMs - 1000 + 120,
    `${end.toFixed(0)}ms, edit ends at ${(sourceMs - 1000).toFixed(0)}ms`,
  )

  // Clearing them puts the file back.
  player.setCuts([])
  await sleep(400)
  check(
    'clearing the cuts restores the full duration',
    Math.abs(player.compositionDuration() - sourceMs) < 1,
    `${player.compositionDuration().toFixed(0)}ms`,
  )

  // ---- re-sending what is already loaded ----------------------------------
  //
  // The editor re-sends the whole composition whenever anything in it moves,
  // and a slider drag emits one of those per pixel of travel. Applying cuts is
  // the one setter that cannot re-render in place -- it throws the frame queue
  // away and decodes again from the playhead -- so if it acted on a track it
  // already had, every edit made during playback cost a held frame and then a
  // jump over the ones the re-seek ate.

  console.log('\nre-applying the same cuts')
  player.setCuts([CUT])
  await sleep(400)

  player.seek(500, true)
  await sleep(300)
  player.play()

  const presented = []
  const startedAt = Date.now()
  let resent = null
  while (Date.now() - startedAt < 1600) {
    const frame = player.tick()
    if (frame) presented.push(frame.pts)
    if (resent === null && Date.now() - startedAt > 700) {
      resent = player.stats()
      // The same edit, written differently: out of order, overlapping, and with
      // an empty span in it. Normalised, it is the track already loaded.
      player.setCuts([
        { startMs: 2500, endMs: 3000 },
        { startMs: 2000, endMs: 2600 },
        { startMs: 1000, endMs: 1000 },
      ])
    }
    await sleep(4)
  }
  player.pause()

  const repeats = presented.filter((pts, i) => i > 0 && pts <= presented[i - 1]).length
  check(
    'playback does not stall or repeat a frame when the same cuts are re-sent',
    repeats === 0,
    `${repeats} of ${presented.length} frames repeated or went backwards`,
  )
  check(
    'the same edit written differently does not re-seek the decoder',
    player.stats().lastSeekDecoded === resent.lastSeekDecoded,
    `${resent.lastSeekDecoded} -> ${player.stats().lastSeekDecoded} frames decoded on the last seek`,
  )
  check(
    'and it is still the same edit afterwards',
    Math.abs(player.compositionDuration() - (sourceMs - 1000)) < 1,
    `${player.compositionDuration().toFixed(0)}ms`,
  )

  player.close()

  // ---- export -------------------------------------------------------------

  console.log('\nexport')
  const outPath = path.join(workDir, 'cut.mp4')
  const exporter = new velocity.VideoExporter(clipPath, {
    output: outPath,
    bitrate: 4_000_000,
    cuts: [CUT],
  })
  let progress = exporter.progress()
  while (!progress.finished) {
    await sleep(150)
    progress = exporter.progress()
    if (progress.error) break
  }
  check('export finished', !progress.error, progress.error ?? `${progress.framesDone} frames`)

  const outInfo = new velocity.VideoDecoder(outPath).info()
  check(
    'the exported file is shorter by the cut',
    Math.abs(outInfo.duration - (sourceMs - 1000)) < 200,
    `${outInfo.duration.toFixed(0)}ms vs ${(sourceMs - 1000).toFixed(0)}ms`,
  )
} finally {
  try {
    fs.rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
