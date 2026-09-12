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

  /** How close a frame's pts has to be to the clock to count as answering it. */
  const SEEK_LANDED_MS = 40

  /**
   * Seek, and wait for the frame that actually answers the seek.
   *
   * `seek` returns before the decode thread has moved, and the first `tick`
   * after it still hands back the frame that was already on screen -- so a pts
   * read from that frame is the *old* playhead, which can be seconds away from
   * the new one. Anything placed relative to it then lands nowhere near where
   * the playhead ends up, and the cursor checks below read as "nothing was
   * drawn" when the pointer is really parked off in the stretch of timeline
   * that was just left.
   *
   * The engine clock moves on the seek immediately, so a presented frame
   * agreeing with it is what separates the new frame from the stale one.
   */
  async function seekSettled(ms, timeoutMs = 5000) {
    player.seek(ms, true)

    const deadline = Date.now() + timeoutMs
    let pts = null
    while (Date.now() < deadline) {
      pts = player.tick()?.pts ?? pts
      const clock = player.stats().currentTime
      if (pts !== null && Math.abs(pts - clock) <= SEEK_LANDED_MS) return pts
      await sleep(2)
    }
    return pts ?? player.stats().currentTime
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

  /** Scan the whole frame for a pixel matching `test`, handed (b, g, r). */
  function findBgraAnywhere(buf, test) {
    if (!buf) return null
    for (let row = 0; row < info.codedHeight; row += 4) {
      for (let col = 0; col < info.codedWidth; col += 4) {
        const i = row * stride * 4 + col * 4
        if (test(buf[i], buf[i + 1], buf[i + 2])) return { x: col, y: row }
      }
    }
    return null
  }

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

  // A webcam cut takes the camera out of a stretch that keeps playing. Distinct
  // from `setCuts`, which removes the time itself -- here the frame is still
  // there, with nothing of the camera in it.
  if (hasWebcam) {
    player.setWebcamCuts([{ startMs: 0, endMs: Math.max(400, info.duration) }])
    await sleep(400)
    await seekSettled(Math.min(10, info.duration * 0.5))
    await sleep(300)
    const duringCut = player.snapshotBgra()

    check(
      'a webcam cut takes the camera out of the frame',
      difference(inside(plain), inside(duringCut)) < 6,
      `delta ${difference(inside(plain), inside(duringCut)).toFixed(1)} against no camera at all`,
    )

    player.setWebcamCuts([])
    await sleep(400)
    await seekSettled(Math.min(10, info.duration * 0.5))
    await sleep(300)
    check('and clearing the cut brings it back', difference(inside(plain), inside(player.snapshotBgra())) > 6)
  } else {
    skip('a webcam cut takes the camera out of the frame', 'no camera in this run')
  }

  // Layer order. Put the camera over the whole frame and the pointer under it,
  // then flip them: whichever is on top owns the pixels where they overlap.
  if (hasWebcam) {
    player.setWebcamLayout({ x: 0, y: 0, width: info.codedWidth, height: info.codedHeight })
    player.setCursorImage({
      width: 64,
      height: 64,
      pixels: solidRgba(64, 64, [255, 0, 255, 255]),
      hotspotX: 32,
      hotspotY: 32,
    })
    player.setCursorStyle(64, 1)
    player.setCursorTrack([{ timestampMs: -100, x: 0.5, y: 0.5 }])

    player.setLayerOrder(['video', 'cursor', 'webcam'])
    await sleep(400)
    await seekSettled(Math.min(10, info.duration * 0.5))
    await sleep(300)
    const cursorUnder = player.snapshotBgra()

    player.setLayerOrder(['video', 'webcam', 'cursor'])
    await sleep(400)
    const cursorOver = player.snapshotBgra()

    const isMagentaPixel = (b, g, r) => b > 200 && g < 60 && r > 200
    const magentaUnder = findBgraAnywhere(cursorUnder, isMagentaPixel)
    const magentaOver = findBgraAnywhere(cursorOver, isMagentaPixel)

    check('with the camera on top the pointer is hidden by it', magentaUnder === null)
    check('and moving the pointer above brings it back', magentaOver !== null)

    player.setLayerOrder([])
    player.setCursorTrack([])
    player.setCursorImage(null)
  } else {
    skip('layer order decides what covers what', 'no camera in this run')
  }

  // Webcam zoom regions: the camera grows for a span, or takes the whole frame.
  // The engine eases between the box it was given and the one the region
  // carries, so both are laid out here and only the interpolation is its job.
  if (hasWebcam) {
    const smallBox = { x: 1400, y: 700, width: 320, height: 180 }
    player.setWebcamLayout({ ...smallBox, shape: 'rect', cornerRadius: 0, opacity: 1 })
    player.setWebcamZoomRegions([])
    await sleep(400)
    await seekSettled(Math.min(10, info.duration * 0.5))
    await sleep(300)
    const small = player.snapshotBgra()

    // A region held over the sampled frame, with no ease so it is fully in
    // effect rather than partway through one.
    player.setWebcamZoomRegions([
      {
        startMs: -10_000,
        endMs: 10_000,
        easeDurationMs: 0,
        rect: { x: 200, y: 200, width: 900, height: 500 },
        fullScreen: false,
      },
    ])
    await sleep(400)
    const grown = player.snapshotBgra()

    // Somewhere inside the grown box but well outside the small one.
    const onlyWhenGrown = (buf) => averageBgra(buf, stride, 400, 400, 60, 60)
    check(
      'a webcam zoom region grows the camera',
      difference(onlyWhenGrown(small), onlyWhenGrown(grown)) > 12,
      `delta ${difference(onlyWhenGrown(small), onlyWhenGrown(grown)).toFixed(1)}`,
    )

    // Full canvas: the camera should reach a corner it could never reach as a box.
    player.setWebcamZoomRegions([
      {
        startMs: -10_000,
        endMs: 10_000,
        easeDurationMs: 0,
        rect: smallBox,
        fullScreen: true,
      },
    ])
    await sleep(400)
    const expanded = player.snapshotBgra()

    const farCorner = (buf) => averageBgra(buf, stride, 30, info.codedHeight - 90, 60, 60)
    check(
      'and full-canvas mode fills the frame with it',
      difference(farCorner(small), farCorner(expanded)) > 12,
      `delta ${difference(farCorner(small), farCorner(expanded)).toFixed(1)}`,
    )

    player.setWebcamZoomRegions([])
  } else {
    skip('a webcam zoom region grows the camera', 'no camera in this run')
  }

  // Webcam shadows. Analytic rather than a blur pass, so the thing worth
  // checking is not "is there a shadow" but "does it behave like a blur":
  // strongest at the edge, fading with distance, and *ending* where the quad
  // ends. A hard silhouette or a clipped falloff would both still be a shadow.
  if (hasWebcam) {
    const shadowBox = { x: 700, y: 300, width: 320, height: 180 }
    const bottom = shadowBox.y + shadowBox.height
    const blur = 40
    // Matches SHADOW_SOFTNESS_PER_BLUR: past this the falloff is over.
    const reach = blur * 0.94 + 1

    const layout = { ...shadowBox, shape: 'rect', cornerRadius: 0, opacity: 1 }
    player.setWebcamLayout(layout)
    await sleep(400)
    await seekSettled(Math.min(10, info.duration * 0.5))
    await sleep(300)
    const bare = player.snapshotBgra()

    // Magenta, so the measurement does not depend on what the video happens to
    // be showing under the box -- a black shadow over dark footage moves
    // nothing and would pass a "did anything change" test by luck.
    player.setWebcamLayout({
      ...layout,
      shadows: [{ offsetX: 0, offsetY: 0, blur, colour: { r: 1, g: 0, b: 1, a: 1 } }],
    })
    await sleep(400)
    const shadowed = player.snapshotBgra()

    // Three bands below the box: hard against the edge, partway out, and past
    // the end of the falloff.
    const band = (buf, offset, height) => averageBgra(buf, stride, 750, bottom + offset, 100, height)
    const delta = (offset, height) =>
      difference(band(bare, offset, height), band(shadowed, offset, height))

    const near = delta(1, 8)
    const mid = delta(20, 8)
    const past = delta(Math.ceil(reach) + 4, 8)

    check('a webcam shadow falls outside the box', near > 40, `delta ${near.toFixed(1)}`)
    check(
      'and fades with distance rather than stopping dead',
      near > mid + 10,
      `${near.toFixed(1)} at the edge, ${mid.toFixed(1)} further out`,
    )
    // The quad is sized from the same constant the shader fades over. If it
    // were sized short, the falloff would be cut off mid-gradient and this
    // band would still be tinted -- with a straight edge across it.
    check(
      'and ends inside its own quad, with nothing clipped',
      past < 2,
      `delta ${past.toFixed(1)} past the falloff`,
    )

    // An offset shadow is directional: down means down, not both ways.
    player.setWebcamLayout({
      ...layout,
      shadows: [{ offsetX: 0, offsetY: 60, blur: 8, colour: { r: 1, g: 0, b: 1, a: 1 } }],
    })
    await sleep(400)
    const offset = player.snapshotBgra()

    const below = difference(band(bare, 40, 20), band(offset, 40, 20))
    const aboveBar = (buf) => averageBgra(buf, stride, 750, shadowBox.y - 30, 100, 20)
    const above = difference(aboveBar(bare), aboveBar(offset))

    check('an offset shadow lands on the side it was offset to', below > 40, `delta ${below.toFixed(1)}`)
    check('and not on the other one', above < 2, `delta ${above.toFixed(1)}`)

    player.setWebcamLayout(layout)
  } else {
    skip('a webcam shadow falls outside the box', 'no camera in this run')
  }

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

  await seekSettled(10)
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
  await seekSettled(duration * 0.75)
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

  // ---- per-sample bitmaps -------------------------------------------------
  //
  // A real pointer changes shape as it crosses the screen: arrow, then I-beam
  // over text, then a hand over a link. The engine drew one bitmap for the
  // whole track, so what is checked here is that a sample can name its own.
  //
  // Cyan for the second one, because like magenta nothing in a screen
  // recording produces it -- finding either proves which bitmap was chosen,
  // not merely that something was drawn.

  console.log('\nper-sample cursor bitmaps')

  /** Scan for a pixel matching `test`, which is handed (b, g, r). */
  function findBgra(buf, test) {
    if (!buf) return null
    for (let row = 0; row < info.codedHeight; row += 4) {
      for (let col = 0; col < info.codedWidth; col += 4) {
        const i = row * stride * 4 + col * 4
        if (test(buf[i], buf[i + 1], buf[i + 2])) {
          return { x: col, y: row }
        }
      }
    }
    return null
  }

  const isMagenta = (b, g, r) => b > 200 && g < 60 && r > 200
  const isCyan = (b, g, r) => b > 200 && g > 200 && r < 60

  player.setCursorImages([
    {
      width: CURSOR_PX,
      height: CURSOR_PX,
      pixels: solidRgba(CURSOR_PX, CURSOR_PX, [255, 0, 255, 255]),
      hotspotX: 0,
      hotspotY: 0,
    },
    {
      width: CURSOR_PX,
      height: CURSOR_PX,
      pixels: solidRgba(CURSOR_PX, CURSOR_PX, [0, 255, 255, 255]),
      hotspotX: 0,
      hotspotY: 0,
    },
  ])
  player.setCursorStyle(CURSOR_PX, 1)
  player.setCursorTrack([{ timestampMs: 0, x: 0.2, y: 0.2, imageId: 0 }])
  await sleep(400)

  check('the bitmap table loaded', player.cursorImageCount() === 2, `${player.cursorImageCount()} bitmaps`)

  // Find out which instant is actually on screen rather than seeking between
  // two guessed times. A recording of an idle desktop can be a single frame --
  // screen capture only emits on change -- and then a seek presents nothing
  // new, the staged timestamp stays where it was, and the checks below silently
  // resolve against the wrong sample.
  //
  // Setting the track is enough to move between shapes: it repaints, and a
  // repaint re-stages the pointer against the frame already on screen.
  const shapeMs = await seekSettled(Math.min(10, duration * 0.5))

  player.setCursorTrack([{ timestampMs: shapeMs - 100, x: 0.2, y: 0.2, imageId: 0 }])
  await sleep(400)
  const firstShape = player.snapshotBgra()

  check('the first sample draws its own bitmap', findBgra(firstShape, isMagenta) !== null)
  check('and not the other one', findBgra(firstShape, isCyan) === null)

  player.setCursorTrack([
    { timestampMs: shapeMs - 100, x: 0.2, y: 0.2, imageId: 0 },
    { timestampMs: shapeMs, x: 0.75, y: 0.75, imageId: 1 },
  ])
  await sleep(400)
  const secondShape = player.snapshotBgra()

  check('the second sample draws a different bitmap', findBgra(secondShape, isCyan) !== null)
  check('and the first is gone', findBgra(secondShape, isMagenta) === null)

  // An id past the end of the table falls back to the default bitmap rather
  // than hiding the pointer: a missing image should look wrong, not absent.
  player.setCursorTrack([{ timestampMs: shapeMs - 100, x: 0.2, y: 0.2, imageId: 99 }])
  await sleep(400)

  check('an unknown bitmap id falls back to the default pointer', findBgra(player.snapshotBgra(), isMagenta) !== null)

  // ---- click pop and smear ------------------------------------------------
  //
  // Both change the pointer's *rectangle* rather than its bitmap, so both show
  // up as magenta appearing where it was not before: more of it around the
  // hotspot for a click, a tail of it behind the pointer for a smear.
  //
  // The tail is checked by comparing the same band of pixels with the effect on
  // and off rather than by hunting for pure magenta. The smear fades out along
  // its length, so most of it is magenta blended over whatever the desktop was
  // showing, and an absolute colour threshold would only ever find the part
  // nearest the head.

  console.log('\nclick pop and smear')

  /** Count pixels matching `test`, on the same coarse grid as findBgra. */
  function countBgra(buf, test) {
    let n = 0
    if (!buf) return n
    for (let row = 0; row < info.codedHeight; row += 4) {
      for (let col = 0; col < info.codedWidth; col += 4) {
        const i = row * stride * 4 + col * 4
        if (test(buf[i], buf[i + 1], buf[i + 2])) n += 1
      }
    }
    return n
  }

  /** Bounding box of the pixels matching `test`, or null if there are none. */
  function boundsBgra(buf, test) {
    let box = null
    if (!buf) return box
    for (let row = 0; row < info.codedHeight; row += 2) {
      for (let col = 0; col < info.codedWidth; col += 2) {
        const i = row * stride * 4 + col * 4
        if (!test(buf[i], buf[i + 1], buf[i + 2])) continue
        box ??= { minX: col, maxX: col, minY: row, maxY: row }
        box.minX = Math.min(box.minX, col)
        box.maxX = Math.max(box.maxX, col)
        box.minY = Math.min(box.minY, row)
        box.maxY = Math.max(box.maxY, row)
      }
    }
    return box
  }

  // A hotspot in the middle, so a click grows the block evenly instead of
  // pushing it off one edge, and the tail is easy to measure against it.
  player.setCursorImages([])
  player.setCursorImage({
    width: CURSOR_PX,
    height: CURSOR_PX,
    pixels: solidRgba(CURSOR_PX, CURSOR_PX, [255, 0, 255, 255]),
    hotspotX: CURSOR_PX / 2,
    hotspotY: CURSOR_PX / 2,
  })
  player.setCursorStyle(CURSOR_PX, 1)
  player.setCursorEffects({})
  player.setCursorTrack([{ timestampMs: 0, x: 0.5, y: 0.5 }])

  // Which frame a seek actually lands on. A recording of an idle desktop can be
  // two frames long, and everything below is timed against the pointer being
  // fresh at whatever instant is on screen -- guessing it from `duration` would
  // quietly resolve to no motion at all and pass by drawing nothing.
  const nowMs = await seekSettled(Math.min(10, duration * 0.5))
  await sleep(300)

  // A pointer that has been sitting still: no click to animate, and nothing to
  // measure a velocity from. Everything else is compared against this.
  const still = [
    { timestampMs: nowMs - 100, x: 0.5, y: 0.5 },
    { timestampMs: nowMs - 60, x: 0.5, y: 0.5 },
  ]
  player.setCursorTrack(still)
  await sleep(300)
  const plainArea = countBgra(player.snapshotBgra(), isMagenta)

  check('the resting pointer is drawn', plainArea > 0, `${plainArea} samples`)

  // The pop peaks 18% of the way through its duration.
  const CLICK_MS = 500
  const CLICK_PEAK_MS = CLICK_MS * 0.18

  player.setCursorEffects({ clickScale: 2, clickDurationMs: CLICK_MS })
  player.setCursorTrack([
    { timestampMs: nowMs - 100, x: 0.5, y: 0.5 },
    { timestampMs: nowMs - CLICK_PEAK_MS, x: 0.5, y: 0.5, click: true },
  ])
  await sleep(300)
  const poppedArea = countBgra(player.snapshotBgra(), isMagenta)

  // Twice the scale is four times the area; anything above 2.5x is unambiguous
  // and leaves room for the block being clipped by an edge of the frame.
  check('a click grows the pointer', poppedArea > plainArea * 2.5, `${poppedArea} vs ${plainArea} at rest`)

  player.setCursorTrack([
    { timestampMs: nowMs - CLICK_MS - 50, x: 0.5, y: 0.5, click: true },
    { timestampMs: nowMs - 60, x: 0.5, y: 0.5 },
  ])
  await sleep(300)
  const settledArea = countBgra(player.snapshotBgra(), isMagenta)

  check(
    'and lets go of it once the pop is over',
    Math.abs(settledArea - plainArea) <= 2,
    `${settledArea} vs ${plainArea} at rest`,
  )

  // The trap the click list exists to avoid. A drag emits a mousemove a few
  // milliseconds after the click, and if the pop were a property of the sample
  // in effect that move would end it -- exactly when a click most needs to be
  // visible.
  player.setCursorTrack([
    { timestampMs: nowMs - CLICK_PEAK_MS, x: 0.5, y: 0.5, click: true },
    { timestampMs: nowMs - CLICK_PEAK_MS + 10, x: 0.5, y: 0.5 },
  ])
  await sleep(300)
  const draggedArea = countBgra(player.snapshotBgra(), isMagenta)

  check(
    'a move right after a click does not cut the pop short',
    draggedArea > plainArea * 2.5,
    `${draggedArea} vs ${plainArea} at rest`,
  )

  // ---- the smear ----------------------------------------------------------

  // A quarter of the frame in twenty milliseconds: far past the cap, which is
  // the point -- a real flick of the mouse always is.
  const flick = [
    { timestampMs: nowMs - 20, x: 0.35, y: 0.5 },
    { timestampMs: nowMs, x: 0.6, y: 0.5 },
  ]

  player.setCursorEffects({})
  player.setCursorTrack(flick)
  await sleep(300)
  const unsmeared = player.snapshotBgra()
  const head = boundsBgra(unsmeared, isMagenta)

  if (!head) {
    skip('a fast pointer leaves a tail behind it', 'the pointer was not drawn')
  } else {
    // A band behind the pointer, clear of it, and well inside the cap.
    const band = {
      x: Math.max(0, head.minX - 160),
      y: Math.max(0, Math.floor((head.minY + head.maxY) / 2) - 16),
      w: 100,
      h: 32,
    }
    // The mirror of it in front, where a smear must never reach: the pointer
    // has not been there yet.
    const ahead = { ...band, x: Math.min(info.codedWidth - band.w - 1, head.maxX + 60) }

    const before = averageBgra(unsmeared, stride, band.x, band.y, band.w, band.h)
    const aheadBefore = averageBgra(unsmeared, stride, ahead.x, ahead.y, ahead.w, ahead.h)

    player.setCursorEffects({ smearStrength: 1 })
    player.setCursorTrack(flick)
    await sleep(300)
    const smeared = player.snapshotBgra()

    const after = averageBgra(smeared, stride, band.x, band.y, band.w, band.h)
    const aheadAfter = averageBgra(smeared, stride, ahead.x, ahead.y, ahead.w, ahead.h)

    // Magenta is red and blue without green, so the tail has to push both of
    // those up. Checking "it changed" would also pass for a grey smudge.
    check(
      'a fast pointer leaves a tail behind it',
      after[0] - before[0] > 30 && after[2] - before[2] > 30,
      `r +${(after[0] - before[0]).toFixed(0)}, b +${(after[2] - before[2]).toFixed(0)}`,
    )

    check(
      'and the tail is behind it, not in front',
      difference(aheadAfter, aheadBefore) < 12,
      `delta ${difference(aheadAfter, aheadBefore).toFixed(1)} ahead of the pointer`,
    )

    // The cap. This flick covers a quarter of the frame in twenty milliseconds,
    // which uncapped is a streak most of the way across it; the cap holds the
    // tail to a few times the pointer's height. Measured past where the tail is
    // allowed to reach, because the fade means the *visibly* magenta part stops
    // well before the geometry does -- checking the bright end would pass for
    // any cap at all.
    const beyond = {
      ...band,
      x: Math.max(0, head.minX - CURSOR_PX * 4 - 160),
    }
    const beyondBefore = averageBgra(unsmeared, stride, beyond.x, beyond.y, beyond.w, beyond.h)
    const beyondAfter = averageBgra(smeared, stride, beyond.x, beyond.y, beyond.w, beyond.h)

    check(
      'the tail is capped however fast the pointer moves',
      difference(beyondAfter, beyondBefore) < 12,
      `delta ${difference(beyondAfter, beyondBefore).toFixed(1)} past the cap`,
    )

    // Snap back: the same flick, but sampled long enough after the last report
    // that the pointer has plainly stopped. The track holds its last sample
    // forever, so without this the streak would still be there.
    player.setCursorTrack([
      { timestampMs: nowMs - 220, x: 0.35, y: 0.5 },
      { timestampMs: nowMs - 200, x: 0.6, y: 0.5 },
    ])
    await sleep(300)
    const stopped = averageBgra(player.snapshotBgra(), stride, band.x, band.y, band.w, band.h)

    check(
      'a stopped pointer snaps out of its smear',
      difference(stopped, before) < 12,
      `delta ${difference(stopped, before).toFixed(1)}`,
    )
  }

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

  // ---- background image ---------------------------------------------------
  //
  // The editor's backgrounds are not colours. A pattern is a stack of CSS
  // gradients and a custom background is a file on disk; both reach the engine
  // as one canvas-sized RGBA buffer, because reimplementing `conic-gradient` in
  // HLSL would be a second thing that has to match the picker forever.
  //
  // Two halves rather than one flat image, so this also says the buffer is not
  // mirrored or transposed on the way in -- a stretched full-canvas quad hides
  // that, and a background that comes out flipped looks fine until the day
  // someone uses a photograph.

  canvasPlayer.setLayout(inset)

  const halves = Buffer.alloc(CANVAS.width * CANVAS.height * 4)
  for (let y = 0; y < CANVAS.height; y += 1) {
    for (let x = 0; x < CANVAS.width; x += 1) {
      const i = (y * CANVAS.width + x) * 4
      const left = x < CANVAS.width / 2
      halves[i] = 255
      halves[i + 1] = left ? 0 : 255
      halves[i + 2] = left ? 255 : 0
      halves[i + 3] = 255
    }
  }

  canvasPlayer.setBackground({
    // Green still, and nothing should be green any more: the image covers the
    // whole canvas, so a corner reading green means it never got uploaded.
    colour: { r: 0, g: 1, b: 0 },
    image: { width: CANVAS.width, height: CANVAS.height, pixels: halves },
  })

  const withImage = await canvasFrame()
  if (withImage) {
    const topLeft = averageBgra(withImage, canvasStride, 4, 4, 16, 16)
    const topRight = averageBgra(withImage, canvasStride, CANVAS.width - 24, 4, 16, 16)

    check(
      'a background image replaces the flat colour',
      !isGreen(topLeft) && !isGreen(topRight),
      `left rgb ${topLeft.map((v) => v.toFixed(0)).join(',')}, right ${topRight.map((v) => v.toFixed(0)).join(',')}`,
    )
    check(
      'the background image is drawn the way round it was given',
      topLeft[2] > 200 && topLeft[1] < 60 && topRight[1] > 200 && topRight[2] < 60,
      `left b ${topLeft[2].toFixed(0)} g ${topLeft[1].toFixed(0)}, right b ${topRight[2].toFixed(0)} g ${topRight[1].toFixed(0)}`,
    )

    // And the recording still sits on top of it.
    const overImage = averageBgra(withImage, canvasStride, CANVAS.width / 2 - 20, CANVAS.height / 2 - 20, 40, 40)
    check(
      'the video draws over the background image',
      !(overImage[2] > 200 && overImage[1] < 60) && !(overImage[1] > 200 && overImage[2] < 60),
      `centre rgb ${overImage.map((v) => v.toFixed(0)).join(',')}`,
    )
  } else {
    check('a background image replaces the flat colour', false, 'no snapshot')
  }

  // Back to a flat colour for the checks that follow.
  canvasPlayer.setBackground({ colour: { r: 0, g: 1, b: 0 } })
  await canvasFrame()

  // ---- shadow -------------------------------------------------------------
  //
  // What lifts the recording off the canvas now that the default border is
  // gone. Measured against the background rather than by eye: a shadow that
  // uploads, sizes its quad and draws nothing visible looks identical to a
  // working one from every other vantage point.

  console.log('')
  // Two bands the same distance out from the video's edge, one above and one
  // below, so the offset's direction is measurable rather than assumed.
  const bandBelow = (frame) => averageBgra(frame, canvasStride, 600, 645, 80, 20)
  const bandAbove = (frame) => averageBgra(frame, canvasStride, 600, 55, 80, 20)

  canvasPlayer.setLayout(inset)
  const noShadow = await canvasFrame()
  const cleanBelow = bandBelow(noShadow)
  const cleanCentre = averageBgra(noShadow, canvasStride, CANVAS.width / 2 - 20, CANVAS.height / 2 - 20, 40, 40)
  check(
    'without a shadow the background below the video is untouched',
    isGreen(cleanBelow),
    `rgb ${cleanBelow.map((v) => v.toFixed(0)).join(',')}`,
  )

  // Straight down and hard to miss: half-opacity black, offset well clear of
  // the edge, blurred wider than the offset so there is a falloff to find.
  canvasPlayer.setLayout({
    ...inset,
    shadows: [{ offsetX: 0, offsetY: 18, blur: 45, colour: { r: 0, g: 0, b: 0, a: 0.5 } }],
  })
  const withShadow = await canvasFrame()

  if (withShadow) {
    const below = bandBelow(withShadow)
    const above = bandAbove(withShadow)

    check(
      'a shadow darkens the background under the video',
      below[1] < cleanBelow[1] - 20,
      `green ${cleanBelow[1].toFixed(0)} -> ${below[1].toFixed(0)}`,
    )
    // The offset is downward, so the same distance above the video should be
    // far less darkened. Without this the check passes on a shadow drawn as an
    // even ring, which is what a dropped offset looks like.
    check(
      'the shadow falls the way its offset points',
      above[1] > below[1] + 20,
      `above ${above[1].toFixed(0)} vs below ${below[1].toFixed(0)}`,
    )
    // And it stays behind the recording rather than tinting it. Against the
    // same frame without the shadow rather than an expected colour: the source
    // is a live screen recording, so whatever is at the centre is whatever the
    // desktop was showing.
    const centre = averageBgra(withShadow, canvasStride, CANVAS.width / 2 - 20, CANVAS.height / 2 - 20, 40, 40)
    check(
      'the shadow does not darken the video itself',
      difference(centre, cleanCentre) < 12,
      `centre rgb ${centre.map((v) => v.toFixed(0)).join(',')} vs ${cleanCentre.map((v) => v.toFixed(0)).join(',')}`,
    )

    // Far enough out and it is gone: a smoothstep falloff actually reaches
    // zero, so nothing should be tinted at the canvas edge.
    const farBelow = averageBgra(withShadow, canvasStride, 600, CANVAS.height - 8, 80, 6)
    check(
      'the shadow reaches zero rather than tinting the whole canvas',
      isGreen(farBelow),
      `rgb ${farBelow.map((v) => v.toFixed(0)).join(',')}`,
    )
  } else {
    check('a shadow darkens the background under the video', false, 'no snapshot')
  }

  canvasPlayer.setLayout(inset)
  await canvasFrame()

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
