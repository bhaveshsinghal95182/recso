// Desktop + webcam + cursor, composited in the engine, verified by reading the
// finished frame back.
//
// Records both tracks, opens them as one player, places the camera box, loads a
// synthetic pointer path, and then checks the pixels actually changed where each
// layer was put -- and did not change where it was not. Colour readback is the
// only way to tell a composited frame from one that silently drew nothing.
//
// usage: node velocity/scripts/composition-check.mjs [seconds]

import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const velocity = require(path.resolve(here, '..', 'index.js'))

const seconds = Number(process.argv[2] ?? 5)
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-composition-'))
const screenPath = path.join(workDir, 'recording.mp4')
// The recorder derives the camera sidecar's name from the screen file.
const webcamPath = screenPath.replace(/\.mp4$/, '_camera.mp4')

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

try {
  // ---- record both tracks -------------------------------------------------

  console.log(`recording ${seconds}s of screen + webcam -> ${workDir}\n`)

  const devices = velocity.listWebcamDevices()
  if (devices.length === 0) {
    console.log('no webcam on this machine')
  } else {
    console.log(`camera: ${devices.find((d) => d.isDefault)?.label ?? devices[0].label}`)
  }

  // The camera is shared hardware, and its startup times out for reasons that
  // have nothing to do with this code -- another app holding it, or the driver
  // still letting go of the previous run. Only the overlay section needs it, so
  // a camera that will not start degrades to a screen-only recording rather
  // than taking the canvas and zoom sections down with it.
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

  const hasWebcam = withCamera && fs.existsSync(webcamPath)
  if (withCamera) {
    check('camera sidecar exists', hasWebcam)
  } else {
    skip('camera sidecar exists', 'no camera in this run')
  }

  // ---- open both as one player -------------------------------------------

  console.log('\nplayer')
  const player = velocity.VideoPlayer.open({
    path: screenPath,
    webcamPath: hasWebcam ? webcamPath : undefined,
  })
  const info = player.info()

  if (hasWebcam) {
    check('webcam track opened', player.hasWebcam())
  } else {
    skip('webcam track opened', 'no camera in this run')
  }
  console.log(`        canvas ${info.codedWidth}x${info.codedHeight}`)

  async function waitFrame(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const frame = player.tick()
      if (frame) return frame
      await sleep(2)
    }
    return null
  }

  check('first frame decodes', (await waitFrame()) !== null)

  const stride = info.codedWidth

  // Baseline: no overlays placed yet.
  const plain = player.snapshotBgra()
  check('snapshot reads back a frame', Boolean(plain), `${plain?.length ?? 0} bytes`)
  check('snapshot is the full coded frame', plain?.length === info.codedWidth * info.codedHeight * 4)

  // ---- webcam overlay -----------------------------------------------------

  const box = {
    x: Math.round(info.codedWidth * 0.6),
    y: Math.round(info.codedHeight * 0.6),
    width: Math.round(info.codedWidth * 0.25),
    height: Math.round(info.codedHeight * 0.25),
  }

  player.setWebcamLayout({ ...box, shape: 'rect', opacity: 1 })
  await sleep(400)
  const withWebcam = player.snapshotBgra()

  // Sample well inside the box, and somewhere the box does not reach.
  const inside = (buf) => averageBgra(buf, stride, box.x + box.width / 4, box.y + box.height / 4, 40, 40)
  const outside = (buf) => averageBgra(buf, stride, 20, 20, 40, 40)

  if (hasWebcam) {
    check(
      'webcam changed pixels inside its box',
      difference(inside(plain), inside(withWebcam)) > 6,
      `delta ${difference(inside(plain), inside(withWebcam)).toFixed(1)}`,
    )
  } else {
    skip('webcam changed pixels inside its box', 'no camera in this run')
  }
  check(
    'webcam left the rest of the frame alone',
    difference(outside(plain), outside(withWebcam)) < 6,
    `delta ${difference(outside(plain), outside(withWebcam)).toFixed(1)}`,
  )

  // An empty box is the off switch, and must cost nothing.
  player.setWebcamLayout({ x: 0, y: 0, width: 0, height: 0 })
  await sleep(400)
  const webcamOff = player.snapshotBgra()
  check(
    'a zero-size box removes the overlay',
    difference(inside(plain), inside(webcamOff)) < 6,
    `delta ${difference(inside(plain), inside(webcamOff)).toFixed(1)}`,
  )

  // ---- cursor -------------------------------------------------------------

  console.log('\ncursor')

  // A magenta block: nothing in a screen recording looks like this, so finding
  // it proves the sprite was drawn rather than something else moving.
  const CURSOR_PX = 64
  player.setCursorImage({
    width: CURSOR_PX,
    height: CURSOR_PX,
    pixels: solidRgba(CURSOR_PX, CURSOR_PX, [255, 0, 255, 255]),
    hotspotX: 0,
    hotspotY: 0,
  })
  player.setCursorStyle(CURSOR_PX, 1)

  // Two samples far apart, so the pointer is in a different place depending on
  // where the playhead is.
  const duration = info.duration
  player.setCursorTrack([
    { timestampMs: 0, x: 0.2, y: 0.2 },
    { timestampMs: duration * 0.5, x: 0.75, y: 0.75 },
  ])
  await sleep(400)

  check('track loaded', player.cursorSampleCount() === 2, `${player.cursorSampleCount()} samples`)

  function findMagenta(buf) {
    if (!buf) return null
    for (let row = 0; row < info.codedHeight; row += 4) {
      for (let col = 0; col < info.codedWidth; col += 4) {
        const i = row * stride * 4 + col * 4
        // BGRA: blue and red high, green low.
        if (buf[i] > 200 && buf[i + 1] < 60 && buf[i + 2] > 200) {
          return { x: col, y: row }
        }
      }
    }
    return null
  }

  player.seek(10, true)
  await waitFrame()
  await sleep(300)
  const early = findMagenta(player.snapshotBgra())

  check('cursor is drawn', early !== null, early ? `at ${early.x},${early.y}` : 'not found')
  if (early) {
    // First sample sits at 20% across, and the hotspot is the top-left corner.
    const wantX = 0.2 * info.codedWidth
    const wantY = 0.2 * info.codedHeight
    check(
      'cursor is at the position the track gives',
      Math.abs(early.x - wantX) < 40 && Math.abs(early.y - wantY) < 40,
      `found ${early.x},${early.y}, expected near ${wantX.toFixed(0)},${wantY.toFixed(0)}`,
    )
  }

  // Move the playhead past the second sample; the pointer should follow.
  player.seek(duration * 0.75, true)
  await waitFrame()
  await sleep(300)
  const late = findMagenta(player.snapshotBgra())

  check('cursor still drawn after a seek', late !== null, late ? `at ${late.x},${late.y}` : '')
  if (early && late) {
    check(
      'cursor moved to the later sample',
      late.x > early.x + 100 && late.y > early.y + 100,
      `${early.x},${early.y} -> ${late.x},${late.y}`,
    )
  }

  // Size 0 is the off switch.
  player.setCursorStyle(0, 1)
  await sleep(400)
  check('size 0 hides the cursor', findMagenta(player.snapshotBgra()) === null)

  player.close()

  // ---- canvas, background, video placement --------------------------------
  //
  // A second player, because the canvas is fixed when one is opened: its size
  // is the size of the textures already handed to Chromium.

  console.log('\ncanvas')

  const CANVAS = { width: 1280, height: 720 }
  // Inset by an eighth on each side, so there is background on every edge.
  const inset = {
    x: CANVAS.width / 8,
    y: CANVAS.height / 8,
    width: (CANVAS.width * 3) / 4,
    height: (CANVAS.height * 3) / 4,
  }

  const canvasPlayer = velocity.VideoPlayer.open({
    path: screenPath,
    canvasWidth: CANVAS.width,
    canvasHeight: CANVAS.height,
  })

  const canvasInfo = canvasPlayer.info()
  check(
    'the canvas is the size asked for, not the source',
    canvasInfo.codedWidth === CANVAS.width && canvasInfo.codedHeight === CANVAS.height,
    `${canvasInfo.codedWidth}x${canvasInfo.codedHeight}`,
  )

  async function canvasFrame(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (canvasPlayer.tick()) break
      await sleep(2)
    }
    await sleep(250)
    return canvasPlayer.snapshotBgra()
  }

  // Pure green, which no screen recording produces by accident.
  canvasPlayer.setBackground({ colour: { r: 0, g: 1, b: 0 } })
  canvasPlayer.setLayout(inset)
  await canvasFrame()

  const canvasStride = CANVAS.width
  const isGreen = ([r, g, b]) => g > 200 && r < 60 && b < 60
  const composed = await canvasFrame()
  check('canvas snapshot reads back', Boolean(composed), `${composed?.length ?? 0} bytes`)
  check('the snapshot is the canvas, not the source', composed?.length === CANVAS.width * CANVAS.height * 4)

  if (composed) {
    // Every corner is outside the video, so all four have to be background.
    const corners = [
      ['top-left', averageBgra(composed, canvasStride, 4, 4, 16, 16)],
      ['top-right', averageBgra(composed, canvasStride, CANVAS.width - 24, 4, 16, 16)],
      ['bottom-left', averageBgra(composed, canvasStride, 4, CANVAS.height - 24, 16, 16)],
      ['bottom-right', averageBgra(composed, canvasStride, CANVAS.width - 24, CANVAS.height - 24, 16, 16)],
    ]
    const notGreen = corners.filter(([, colour]) => !isGreen(colour))
    check(
      'the background fills every corner',
      notGreen.length === 0,
      notGreen.map(([name]) => name).join(', ') || 'all four green',
    )

    // And the middle is the recording, not the background.
    const middle = averageBgra(composed, canvasStride, CANVAS.width / 2 - 20, CANVAS.height / 2 - 20, 40, 40)
    check(
      'the video is inside the background, not covered by it',
      !isGreen(middle),
      `centre rgb ${middle.map((v) => v.toFixed(0)).join(',')}`,
    )

    // A full-canvas layout is the off switch: the background is completely
    // hidden and nothing of it should survive in a corner.
    canvasPlayer.setLayout({ x: 0, y: 0, width: CANVAS.width, height: CANVAS.height })
    const covered = await canvasFrame()
    check(
      'a full-canvas layout hides the background',
      covered ? !isGreen(averageBgra(covered, canvasStride, 4, 4, 16, 16)) : false,
    )
  }

  // ---- border -------------------------------------------------------------
  //
  // Blue, and thick enough that a 16px sample sits well inside it rather than
  // straddling the feathered edge.
  const BORDER = 24
  canvasPlayer.setLayout({ ...inset, borderWidth: BORDER, borderColour: { r: 0, g: 0, b: 1 } })
  const bordered = await canvasFrame()

  if (bordered) {
    // Just outside the video's edge, inside the border ring.
    const ring = averageBgra(bordered, canvasStride, inset.x + inset.width / 2 - 8, inset.y - BORDER / 2 - 8, 16, 16)
    check(
      'the border is drawn around the video',
      ring[2] > 150 && ring[0] < 80 && ring[1] < 80,
      `rgb ${ring.map((v) => v.toFixed(0)).join(',')}`,
    )
  }

  // ---- zoom ---------------------------------------------------------------
  //
  // The video is inset with green around it, so "is it zoomed" is answerable by
  // asking whether the background survived: 2x about the centre pushes the
  // video's edges past the canvas and the green goes.
  //
  // Regions here cover the whole clip rather than a slice of it, and the
  // on/off test is "regions set" versus "regions cleared". Screen capture only
  // emits a frame when something changes, so an idle desktop produces a
  // recording tens of milliseconds long -- carving that into a timeline and
  // seeking into the middle of a region is not a test of anything. The region
  // maths, easing and boundaries are covered by the Rust unit tests in
  // `engine/zoom.rs`, which is the right place for arithmetic. What pixels can
  // tell us, and unit tests cannot, is whether the zoom reaches the render.

  console.log('\nzoom')

  canvasPlayer.setLayout(inset)

  async function seekAndRead(ms) {
    canvasPlayer.seek(ms, true)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (canvasPlayer.tick()) break
      await sleep(2)
    }
    await sleep(300)
    return canvasPlayer.snapshotBgra()
  }

  const cornerIsGreen = (buf) => Boolean(buf) && isGreen(averageBgra(buf, canvasStride, 4, 4, 16, 16))

  check('with no zoom the background still shows', cornerIsGreen(await seekAndRead(0)))

  const wholeClip = {
    startMs: 0,
    // Past the end, so no frame in the file can fall outside it.
    endMs: Math.max(1000, canvasInfo.duration * 10),
    zoomLevel: 2,
    focalX: 0.5,
    focalY: 0.5,
    easeDurationMs: 0,
  }

  canvasPlayer.setZoomRegions([wholeClip])
  await sleep(300)
  check('zoom regions load', canvasPlayer.zoomRegionCount() === 1, `${canvasPlayer.zoomRegionCount()} regions`)
  check('a zoomed video grows over the background', !cornerIsGreen(await seekAndRead(0)))

  // Off again. The corner coming back proves the zoom is re-resolved per frame
  // rather than baked in when it was first set.
  canvasPlayer.setZoomRegions([])
  await sleep(300)
  check('clearing the regions releases the zoom', cornerIsGreen(await seekAndRead(0)))

  // A focal point away from the centre moves the frame rather than just growing
  // it. Focal (0, 0) pins the *video's* top-left, which sits at the inset
  // position rather than at the canvas corner -- so the video grows down and
  // right from there, covering the far corner while the near margin stays
  // background. Centre focal covers both. That difference is the pivot doing
  // its job, and it is what would break if focal points were resolved against
  // the canvas instead of against the video's placement.
  canvasPlayer.setZoomRegions([{ ...wholeClip, focalX: 0, focalY: 0 }])
  await sleep(300)
  const cornered = await seekAndRead(0)
  const nearCorner = (buf) => averageBgra(buf, canvasStride, 4, 4, 16, 16)
  const farCorner = (buf) => averageBgra(buf, canvasStride, CANVAS.width - 24, CANVAS.height - 24, 16, 16)

  check(
    'a top-left focal point pins the video there, leaving the near margin',
    cornered ? isGreen(nearCorner(cornered)) : false,
  )
  check('and grows it over the far corner', cornered ? !isGreen(farCorner(cornered)) : false)

  canvasPlayer.close()
} finally {
  cleanup()
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
