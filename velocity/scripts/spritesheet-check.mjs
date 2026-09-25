// Timeline filmstrip, end to end: does `generateSpritesheet` actually decode a
// file and write a grid of real thumbnails?
//
// The geometry is easy to get right and easy to check -- the PNG's own IHDR
// says how big it is, and that has to match `columns * frameWidth` by
// `rows * frameHeight`. The interesting failure is the other one: a chain that
// renders nothing still produces a perfectly well-formed PNG of the right size,
// full of transparent or black cells. Nothing about the return value gives that
// away, so this reads the pixels back and insists they vary.
//
// The PNG is decoded here rather than with a library because nothing in this
// repo ships one for Node, and the `image` crate writes exactly one shape:
// 8-bit RGBA, no interlace. That is ~50 lines of zlib and un-filtering, and it
// is asserted rather than assumed.
//
// usage: node velocity/scripts/spritesheet-check.mjs [recordSeconds]

import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const velocity = require(path.resolve(here, '..', 'index.js'))

const recordSeconds = Number(process.argv[2] ?? 5)
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritesheet-check-'))
const clipPath = path.join(workDir, 'recording.mp4')
const sheetPath = path.join(workDir, 'sheet.png')
const narrowSheetPath = path.join(workDir, 'sheet-narrow.png')
const missingSheetPath = path.join(workDir, 'never-written.png')

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

// ---- a very small PNG reader ------------------------------------------------

/** Paeth predictor, straight out of the PNG spec. */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * Decode an 8-bit RGBA, non-interlaced PNG into `{ width, height, pixels }`.
 *
 * Throws on anything else rather than trying to cope: the only writer this ever
 * reads is the `image` crate's RGBA8 encoder, so a different header means the
 * engine changed formats and this check should say so loudly instead of
 * silently comparing garbage.
 */
function readPng(file) {
  const bytes = fs.readFileSync(file)

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!bytes.subarray(0, 8).equals(signature)) {
    throw new Error('not a PNG')
  }

  let width = 0
  let height = 0
  let bitDepth = 0
  let colourType = 0
  let interlace = 0
  const idat = []

  // Chunks: length (4) | type (4) | data | crc (4).
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colourType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }

    offset += 12 + length
  }

  if (bitDepth !== 8 || colourType !== 6 || interlace !== 0) {
    throw new Error(`expected 8-bit RGBA non-interlaced, got depth ${bitDepth} colour ${colourType} interlace ${interlace}`)
  }

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bpp = 4
  const stride = width * bpp
  const pixels = Buffer.alloc(height * stride)

  // Each scanline is prefixed with a filter byte and predicted from the pixel
  // to its left (a), the one above (b) and the one above-left (c).
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)

    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? pixels[y * stride + x - bpp] : 0
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? pixels[(y - 1) * stride + x - bpp] : 0

      let value
      switch (filter) {
        case 0:
          value = line[x]
          break
        case 1:
          value = line[x] + a
          break
        case 2:
          value = line[x] + b
          break
        case 3:
          value = line[x] + ((a + b) >> 1)
          break
        case 4:
          value = line[x] + paeth(a, b, c)
          break
        default:
          throw new Error(`unknown PNG filter ${filter} on row ${y}`)
      }
      pixels[y * stride + x] = value & 0xff
    }
  }

  return { width, height, pixels }
}

/**
 * How much one cell varies: the spread of every channel across the cell, and
 * how much of it is opaque.
 *
 * A cell that rendered nothing is either fully transparent (the chain never ran)
 * or one flat colour (it ran and drew a clear). Both come back with a spread of
 * zero, which is the whole point of looking.
 */
function describeCell(image, col, row, cellWidth, cellHeight) {
  let min = [255, 255, 255]
  let max = [0, 0, 0]
  let opaque = 0
  let total = 0

  for (let y = row * cellHeight; y < (row + 1) * cellHeight; y += 1) {
    for (let x = col * cellWidth; x < (col + 1) * cellWidth; x += 1) {
      const i = (y * image.width + x) * 4
      for (let ch = 0; ch < 3; ch += 1) {
        if (image.pixels[i + ch] < min[ch]) min[ch] = image.pixels[i + ch]
        if (image.pixels[i + ch] > max[ch]) max[ch] = image.pixels[i + ch]
      }
      if (image.pixels[i + 3] > 0) opaque += 1
      total += 1
    }
  }

  return {
    spread: Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]),
    opaqueFraction: total === 0 ? 0 : opaque / total,
  }
}

// ---- the check --------------------------------------------------------------

/** Below this there is not enough timeline to be worth building a sheet from. */
const USABLE_CLIP_MS = 1500

try {
  // ---- a source to build a sheet from -------------------------------------

  console.log(`recording ${recordSeconds}s of the primary monitor -> ${workDir}\n`)

  let source = clipPath
  let sourceNote = 'the screen recording'

  try {
    const stopper = velocity.startMonitorRecordingV2({
      outputPath: clipPath,
      bitrate: 8_000_000,
      includeSystemAudio: false,
      targetFps: 30,
      enableWebcam: false,
    })
    await sleep(recordSeconds * 1000)
    stopper.stop()
  } catch (error) {
    console.log(`recorder would not start: ${error.message ?? error}`)
  }

  // Windows only delivers a frame when the screen changes, so an idle desktop
  // produces a clip a few tens of milliseconds long -- there is no filmstrip in
  // that, and failing on it would be blaming the engine for a still desktop.
  // `PatternEncoder` writes a fixed number of frames at a fixed rate, which is
  // the same reason `cuts-check` uses it.
  let recordedMs = 0
  try {
    const player = new velocity.VideoPlayer(clipPath)
    recordedMs = player.info().duration
    player.close()
  } catch {
    recordedMs = 0
  }

  if (recordedMs < USABLE_CLIP_MS) {
    const FPS = 30
    source = path.join(workDir, 'pattern.mp4')
    const encoder = new velocity.PatternEncoder(source, 1280, 720, FPS, 4_000_000)
    for (let i = 0; i < FPS * 6; i += 1) encoder.writeFrame()
    encoder.finish()
    sourceNote = `a synthetic 6s clip -- the screen only moved enough for ${(recordedMs / 1000).toFixed(1)}s`
  }

  const player = new velocity.VideoPlayer(source)
  const sourceInfo = player.info()
  const sourceMs = sourceInfo.duration
  player.close()

  console.log(`source: ${sourceNote}`)
  console.log(`        ${sourceInfo.width}x${sourceInfo.height}, ${sourceMs.toFixed(0)}ms\n`)

  // ---- the sheet ----------------------------------------------------------

  console.log('generate')

  const startedAt = Date.now()
  const promise = velocity.generateSpritesheet(source, sheetPath)
  check('returns a promise rather than blocking', typeof promise?.then === 'function')

  const info = await promise
  const elapsed = Date.now() - startedAt
  console.log(`        ${elapsed}ms for ${info.frameCount} frames`)

  check('the image path echoes what was asked for', info.imagePath === sheetPath, info.imagePath)
  check('there is at least one frame', info.frameCount >= 1, `${info.frameCount}`)
  check('the interval is positive', info.intervalMs > 0, `${info.intervalMs}ms`)
  check('the cell has both dimensions', info.frameWidth > 0 && info.frameHeight > 0, `${info.frameWidth}x${info.frameHeight}`)
  check(
    'the grid has room for every frame',
    info.columns * info.rows >= info.frameCount,
    `${info.columns}x${info.rows} for ${info.frameCount}`,
  )
  check(
    'the reported duration is the source duration',
    Math.abs(info.totalDurationMs - sourceMs) < 50,
    `${info.totalDurationMs.toFixed(0)}ms vs ${sourceMs.toFixed(0)}ms`,
  )
  check(
    'the last cell boundary lands inside the recording',
    (info.frameCount - 1) * info.intervalMs <= sourceMs,
    `${((info.frameCount - 1) * info.intervalMs).toFixed(0)}ms of ${sourceMs.toFixed(0)}ms`,
  )

  // ---- the PNG on disk ----------------------------------------------------

  console.log('\nimage')

  check('the PNG exists', fs.existsSync(sheetPath))

  const image = readPng(sheetPath)
  console.log(`        ${image.width}x${image.height}`)

  check(
    'the PNG is exactly its grid of cells',
    image.width === info.columns * info.frameWidth && image.height === info.rows * info.frameHeight,
    `${image.width}x${image.height} vs ${info.columns * info.frameWidth}x${info.rows * info.frameHeight}`,
  )

  // ---- did anything actually get drawn? -----------------------------------

  console.log('\npixels')

  const cells = []
  for (let slot = 0; slot < info.frameCount; slot += 1) {
    cells.push(describeCell(image, slot % info.columns, Math.floor(slot / info.columns), info.frameWidth, info.frameHeight))
  }

  const drawn = cells.filter((cell) => cell.opaqueFraction > 0.99)
  console.log(`        ${drawn.length}/${info.frameCount} cells fully opaque`)

  check(
    'the first cell was drawn at all',
    cells[0].opaqueFraction > 0.99,
    `${(cells[0].opaqueFraction * 100).toFixed(0)}% opaque`,
  )

  // The one this script exists for. A chain that renders nothing still writes a
  // structurally perfect PNG; only the pixels tell you it drew a flat clear.
  check(
    'the first cell is a picture, not one flat colour',
    cells[0].spread > 16,
    `channel spread ${cells[0].spread}`,
  )

  check(
    'every drawn cell is a picture',
    drawn.every((cell) => cell.spread > 16),
    `weakest spread ${drawn.length ? Math.min(...drawn.map((c) => c.spread)) : 'n/a'}`,
  )

  // A pass that captured only the first frame and then stalled fills one slot
  // and leaves the rest transparent, which reads as "it worked" from the info
  // alone.
  if (info.frameCount > 1) {
    check(
      'more than one slot got filled',
      drawn.length > 1,
      `${drawn.length} of ${info.frameCount}`,
    )
  } else {
    skip('more than one slot got filled', 'the plan only asked for one')
  }

  // ---- the budget is honoured ---------------------------------------------

  console.log('\noptions')

  const narrow = await velocity.generateSpritesheet(source, narrowSheetPath, {
    maxFrames: 6,
    cellWidth: 64,
    maxColumns: 3,
  })
  check('the frame cap is respected', narrow.frameCount <= 6, `${narrow.frameCount} frames`)
  check('the cell width is what was asked for', narrow.frameWidth === 64, `${narrow.frameWidth}px`)
  check('the column limit is respected', narrow.columns <= 3, `${narrow.columns} columns`)

  const narrowImage = readPng(narrowSheetPath)
  check(
    'the narrow sheet is its own grid of cells',
    narrowImage.width === narrow.columns * narrow.frameWidth &&
      narrowImage.height === narrow.rows * narrow.frameHeight,
    `${narrowImage.width}x${narrowImage.height}`,
  )

  // ---- the failure path ---------------------------------------------------

  console.log('\nbad input')

  const missing = path.join(workDir, 'there-is-no-such-file.mp4')
  let rejected = false
  let message = ''
  try {
    await velocity.generateSpritesheet(missing, missingSheetPath)
  } catch (error) {
    rejected = true
    message = String(error.message ?? error)
  }

  check('a missing input rejects the promise', rejected, message.slice(0, 80))
  check('and no PNG is left behind for it', !fs.existsSync(missingSheetPath))
} catch (error) {
  console.error(`\nthrew: ${error?.stack ?? error}`)
  failures += 1
} finally {
  cleanup()
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
process.exit(failures > 0 ? 1 : 0)
