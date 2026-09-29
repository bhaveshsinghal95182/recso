// Exercise the boundary the application actually uses for an export:
// Electron main-process service -> option normalisation -> native addon -> file.
//
// The lower-level engine checks construct VideoExporter directly. They are
// valuable, but cannot catch a broken service singleton, a bad addon lookup,
// renderer-cloned pixel buffers, or progress/output plumbing.
//
// usage: electron scripts/engine-export-service-app

import { app } from 'electron'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

process.stdout.write('starting Electron export service check\n')

const require = createRequire(import.meta.url)
const root = process.cwd()
const build = 'dist-electron'
const velocity = require(path.resolve(root, 'velocity', 'index.js'))
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recso-export-service-'))
const input = path.join(workDir, 'source.mp4')
const output = path.join(workDir, 'export.mp4')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

try {
  const service = await import(
    pathToFileURL(path.resolve(root, build, 'services', 'engine', 'export.service.js')).href
  )

  const fps = 30
  if (velocity.PatternEncoder) {
    const encoder = new velocity.PatternEncoder(input, 640, 360, fps, 4_000_000)
    for (let frame = 0; frame < fps * 3; frame += 1) encoder.writeFrame()
    encoder.finish()
  } else {
    // PatternEncoder is Windows-only (D3D11). Elsewhere a dev-only ffmpeg makes the source.
    const { execFileSync } = await import('node:child_process')
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      `testsrc2=size=640x360:rate=${fps}:duration=3`, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-profile:v', 'baseline', input])
  }

  console.log('main-process export service')

  // ArrayBuffer is deliberate: this is how a renderer-created pixel buffer
  // reaches the main process through structured clone.
  const pixels = new Uint8Array(8 * 8 * 4)
  for (let at = 0; at < pixels.length; at += 4) {
    pixels[at] = 255
    pixels[at + 3] = 255
  }

  const started = service.startEngineExport(`"${input}"`, {
    output: `"${output}"`,
    bitrate: 4_000_000,
    start: 500,
    end: 2500,
    cursor: { width: 8, height: 8, pixels: pixels.buffer },
    cursorTrack: [{ timestampMs: 1000, x: 0.5, y: 0.5, visible: true }],
  })

  check('quoted paths are accepted and de-quoted', started.output === output, started.output)

  const deadline = Date.now() + 30_000
  let progress = service.engineExportProgress()
  while (progress && !progress.finished && Date.now() < deadline) {
    await sleep(50)
    progress = service.engineExportProgress()
  }

  check('progress reaches a finished state', Boolean(progress?.finished))
  check('the native worker reports no error', !progress?.error, progress?.error)
  check('progress retains the output path', progress?.output === output, progress?.output)
  check('the service wrote an MP4', fs.existsSync(output) && fs.statSync(output).size > 0)

  if (fs.existsSync(output)) {
    const info = new velocity.VideoDecoder(output).info()
    check('the exported file decodes', info.width === 640 && info.height === 360, `${info.width}x${info.height}`)
    check(
      'the requested range controls its duration',
      info.duration >= 1800 && info.duration <= 2200,
      `${info.duration.toFixed(0)}ms`,
    )
  }
} catch (error) {
  check('the service check completes', false, error?.stack ?? String(error))
} finally {
  try {
    fs.rmSync(workDir, { recursive: true, force: true })
  } catch {
    // Best effort: a failed native worker can briefly retain a file handle.
  }

  // A headless Electron app has no window whose closure would drive the normal
  // quit lifecycle. Exit explicitly so this check can never leave `verify`
  // waiting on a successful but still-live browser process.
  app.exit(failures === 0 ? 0 : 1)
}
