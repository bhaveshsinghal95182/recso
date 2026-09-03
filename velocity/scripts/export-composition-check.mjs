// Does the exported file carry the same layers the preview draws?
//
// This exists because it used to not, and nothing noticed. The exporter builds
// its own render chain on its own thread, and for a while it built one with no
// webcam decoder and no cursor -- so an export came out as desktop plus grading
// while the preview beside it looked completely correct. A preview-only check
// cannot catch that by construction: the whole failure is the two paths
// disagreeing.
//
// So this records a real screen + camera pair, exports it twice -- once bare,
// once with the overlays -- and reads pixels back out of both files. Two
// exports rather than one because a screen recording's own content is unknown:
// the only trustworthy statement is "these two differ exactly where an overlay
// was put, and nowhere else".
//
// usage: node velocity/scripts/export-composition-check.mjs [seconds]

import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const velocity = require(path.resolve(here, '..', 'index.js'))

// An existing recording can be used instead of making one. The camera is shared
// hardware and recording it here is the flakiest part of this check, so being
// able to point at velocity/tests/*.mp4 -- which already have their sidecars --
// is what makes the webcam half runnable without a working camera.
const flag = (name) => {
  const at = process.argv.indexOf(name)
  return at === -1 ? null : process.argv[at + 1]
}

const existing = flag('--input')
const seconds = Number((process.argv[2]?.startsWith('--') ? undefined : process.argv[2]) ?? 5)

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-export-composition-'))
const screenPath = existing ?? path.join(workDir, 'recording.mp4')
// The recorder derives the camera sidecar's name from the screen file. `--webcam`
// overrides that, because nothing in the engine requires the two videos to
// actually be a screen and a camera -- any second file exercises the same path,
// which is useful when the pair to hand is not named the way the recorder names
// them.
const webcamPath = flag('--webcam') ?? screenPath.replace(/\.mp4$/, '_camera.mp4')
const barePath = path.join(workDir, 'bare.mp4')
const compositedPath = path.join(workDir, 'composited.mp4')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

function skip(label, why) {
  console.log(`  SKIP  ${label}  ${why}`)
}

function cleanup() {
  try {
    fs.rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/** Solid RGBA block, used as a stand-in cursor bitmap. */
function solidRgba(width, height, [r, g, b, a]) {
  const pixels = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 4] = r
    pixels[i * 4 + 1] = g
    pixels[i * 4 + 2] = b
    pixels[i * 4 + 3] = a
  }
  return pixels
}

/**
 * Average colour of a rectangle in a BGRA buffer.
 *
 * Coordinates are floored: a fractional index into a Buffer reads `undefined`
 * and quietly turns the whole average into NaN, which then compares false
 * against every threshold and looks like "nothing changed".
 */
function averageBgra(pixels, stride, x, y, w, h) {
  let b = 0
  let g = 0
  let r = 0
  let n = 0

  const x0 = Math.floor(x)
  const y0 = Math.floor(y)

  for (let row = y0; row < y0 + h; row += 1) {
    for (let col = x0; col < x0 + w; col += 1) {
      const i = row * stride * 4 + col * 4
      b += pixels[i]
      g += pixels[i + 1]
      r += pixels[i + 2]
      n += 1
    }
  }

  return n === 0 ? [0, 0, 0] : [r / n, g / n, b / n]
}

function difference(a, b) {
  const delta = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
  if (!Number.isFinite(delta)) {
    throw new Error('sampled outside the frame; the comparison would be meaningless')
  }
  return delta
}

async function runExport(input, options) {
  const exporter = new velocity.VideoExporter(input, options)
  let progress = exporter.progress()
  while (!progress.finished) {
    await sleep(150)
    progress = exporter.progress()
    if (progress.error) break
  }
  return progress
}

/**
 * Open an exported file and read back the frame near `atMs`.
 *
 * The player is opened with no overlays set, so anything visible in the result
 * has to have been baked in by the exporter -- which is the entire question.
 */
async function frameAt(file, atMs) {
  const player = velocity.VideoPlayer.open({ path: file })
  try {
    const info = player.info()
    player.seek(atMs, true)

    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (player.tick()) break
      await sleep(2)
    }
    // `tick` returns the first frame that lands; give the queue a moment to
    // settle on the one the seek actually asked for.
    await sleep(250)

    return { info, pixels: player.snapshotBgra() }
  } finally {
    player.close()
  }
}

try {
  // ---- get a screen + camera pair -----------------------------------------

  let width = 1920
  let height = 1080
  let clipMs = seconds * 1000
  let hasWebcam = false

  if (existing) {
    console.log(`using ${screenPath}\n`)

    console.log('input')

    // Probing is not enough. `probeVideo` says the container is readable, which
    // is a different question from whether there is a decoder for what is
    // inside it -- recordings made before the H.264 switch have HEVC tracks
    // that open and then fail with 0xC00D5212 on a machine with no HEVC MFT.
    // Opening a decoder is the only test that covers both.
    let info = null
    try {
      info = new velocity.VideoDecoder(screenPath).info()
    } catch (error) {
      check('recording opens and decodes', false, error.message ?? String(error))
      throw new Error('the input does not decode; nothing below would mean anything')
    }
    check('recording opens and decodes', true, `${info.width}x${info.height}`)

    width = info.width
    height = info.height
    clipMs = info.duration

    if (!fs.existsSync(webcamPath)) {
      skip('camera sidecar decodes', 'no sidecar beside this recording')
    } else {
      try {
        new velocity.VideoDecoder(webcamPath).info()
        hasWebcam = true
      } catch (error) {
        hasWebcam = false
        check('camera sidecar decodes', false, error.message ?? String(error))
      }
      if (hasWebcam) {
        check('camera sidecar decodes', true)
      }
    }
  } else {
    console.log(`recording ${seconds}s of screen + webcam -> ${workDir}\n`)

    const devices = velocity.listWebcamDevices()
    if (devices.length === 0) {
      console.log('no webcam on this machine')
    } else {
      console.log(`camera: ${devices.find((d) => d.isDefault)?.label ?? devices[0].label}`)
    }

    // The camera is shared hardware, and its startup times out for reasons that
    // have nothing to do with this code -- another app holding it, or the
    // driver still letting go of the previous run. Losing the overlay half of
    // the check beats losing all of it, so a camera that will not start
    // degrades to a screen-only recording rather than throwing. Pass --input to
    // skip this whole problem and use a recording that already exists.
    let stopper = null
    let withCamera = devices.length > 0

    if (withCamera) {
      try {
        stopper = velocity.startMonitorRecordingV2({
          outputPath: screenPath,
          bitrate: 8_000_000,
          includeSystemAudio: false,
          targetFps: 30,
          enableWebcam: true,
        })
      } catch (error) {
        console.log(`\ncamera would not start: ${error.message ?? error}`)
        console.log('falling back to a screen-only recording\n')
        withCamera = false
      }
    }

    if (!stopper) {
      stopper = velocity.startMonitorRecordingV2({
        outputPath: screenPath,
        bitrate: 8_000_000,
        includeSystemAudio: false,
        targetFps: 30,
        enableWebcam: false,
      })
    }

    await sleep(seconds * 1000)
    const infos = stopper.stop()

    console.log('recorder')
    const screen = infos.find((info) => info.role === 'screen')
    check('screen track written', Boolean(screen?.usable), `${screen?.frames ?? 0} frames`)

    // A camera that started but wrote no sidecar is a real failure. One that
    // never started is the fallback above, already reported.
    hasWebcam = withCamera && fs.existsSync(webcamPath)
    if (withCamera) {
      check('camera sidecar exists', hasWebcam)
    } else {
      skip('camera sidecar exists', 'no camera in this run')
    }

    width = screen?.width ?? width
    height = screen?.height ?? height
  }

  // Sample the middle of the clip: the first frames of a screen capture are the
  // least stable, and the camera needs a moment to produce anything at all.
  const sampleMs = Math.max(200, clipMs / 2)

  const box = {
    x: Math.round(width * 0.6),
    y: Math.round(height * 0.6),
    width: Math.round(width * 0.25),
    height: Math.round(height * 0.25),
  }

  // A magenta block. Nothing in a screen recording looks like this, so finding
  // it in the file proves the sprite was drawn, and not that something else on
  // screen happened to move.
  const CURSOR_PX = 96
  const cursor = {
    width: CURSOR_PX,
    height: CURSOR_PX,
    pixels: solidRgba(CURSOR_PX, CURSOR_PX, [255, 0, 255, 255]),
    hotspotX: 0,
    hotspotY: 0,
  }
  const cursorTrack = [{ timestampMs: 0, x: 0.2, y: 0.2 }]

  // ---- export twice -------------------------------------------------------

  console.log('\nexport')

  const bare = await runExport(screenPath, {
    output: barePath,
    bitrate: 12_000_000,
  })
  check('bare export finished', !bare.error && bare.framesDone > 0, bare.error ?? `${bare.framesDone} frames`)

  const composited = await runExport(screenPath, {
    output: compositedPath,
    bitrate: 12_000_000,
    webcamPath: hasWebcam ? webcamPath : undefined,
    webcam: hasWebcam ? { ...box, shape: 'rect', opacity: 1 } : undefined,
    cursor,
    cursorTrack,
    cursorSize: CURSOR_PX,
    cursorOpacity: 1,
  })
  check(
    'composited export finished',
    !composited.error && composited.framesDone > 0,
    composited.error ?? `${composited.framesDone} frames`,
  )

  if (failures > 0) {
    throw new Error('exports did not complete; the pixel comparison would be meaningless')
  }

  // ---- read both back -----------------------------------------------------

  console.log('\noutput')

  const a = await frameAt(barePath, sampleMs)
  const b = await frameAt(compositedPath, sampleMs)

  check('bare export re-opens and decodes', Boolean(a.pixels))
  check('composited export re-opens and decodes', Boolean(b.pixels))
  check(
    'both exports are the same size',
    a.info.codedWidth === b.info.codedWidth && a.info.codedHeight === b.info.codedHeight,
    `${a.info.codedWidth}x${a.info.codedHeight} vs ${b.info.codedWidth}x${b.info.codedHeight}`,
  )

  // The exporter crops the coded frame's macroblock padding on the way to the
  // encoder, so what it writes is the visible size -- not the taller thing the
  // decoder hands it.
  check(
    'export is the visible size, not the padded one',
    b.info.width === b.info.codedWidth && b.info.height === b.info.codedHeight,
    `${b.info.width}x${b.info.height} visible in ${b.info.codedWidth}x${b.info.codedHeight} coded`,
  )

  if (!a.pixels || !b.pixels) {
    throw new Error('could not read frames back out of the exports')
  }

  const stride = a.info.codedWidth
  const inside = (buf) => averageBgra(buf, stride, box.x + box.width / 4, box.y + box.height / 4, 40, 40)
  // Well away from both the camera box and the cursor.
  const untouched = (buf) => averageBgra(buf, stride, stride * 0.45, a.info.codedHeight * 0.45, 40, 40)

  const insideDelta = difference(inside(a.pixels), inside(b.pixels))
  const untouchedDelta = difference(untouched(a.pixels), untouched(b.pixels))

  if (hasWebcam) {
    check('webcam is in the exported file', insideDelta > 12, `delta ${insideDelta.toFixed(1)}`)
  } else {
    skip('webcam is in the exported file', 'no camera in this run')
  }
  check('the rest of the exported frame is unchanged', untouchedDelta < 12, `delta ${untouchedDelta.toFixed(1)}`)

  // How magenta a colour is: blue and red together with green missing. Scored
  // rather than thresholded per channel, because "blue high, red high, green
  // low" also passes on plenty of ordinary warm screen content.
  const magenta = ([r, g, b]) => Math.min(b, r) - g

  // Sampled at the position the track asks for rather than by searching the
  // frame for the strongest magenta anywhere. A search is at the mercy of
  // whatever happened to be on screen during the recording -- and it answers
  // the wrong question, since what matters is that the sprite landed *here*.
  //
  // Inset from the corner because the hotspot is the sprite's top-left, and a
  // sample straddling the edge averages in the background.
  const cursorPatch = (buf) => averageBgra(buf, stride, 0.2 * b.info.width + 16, 0.2 * b.info.height + 16, 32, 32)

  const bareCursor = magenta(cursorPatch(a.pixels))
  const compositedCursor = magenta(cursorPatch(b.pixels))

  check('no cursor in the bare export', bareCursor < 60, `magenta ${bareCursor.toFixed(0)} where the cursor would be`)
  // Both an absolute floor and a margin over the bare export: the floor catches
  // a cursor that did not draw, the margin catches a screen that was already
  // magenta there. The value survives an H.264 round trip, so it is nowhere
  // near the 255 the sprite went in as.
  check(
    'cursor is drawn where the track puts it',
    compositedCursor > 120 && compositedCursor > bareCursor + 80,
    `magenta ${compositedCursor.toFixed(0)} vs ${bareCursor.toFixed(0)} bare`,
  )
} finally {
  cleanup()
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
