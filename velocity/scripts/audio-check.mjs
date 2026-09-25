// Does an export actually come out with audio in it?
//
// The engine had no audio at all until recently, and the failure mode being
// guarded here is quiet in both senses: an export that writes an audio stream
// containing silence, or no stream at all, looks completely normal. The video
// is fine, the file opens, the duration is right. Nobody notices until they
// play it back with the volume up.
//
// `probeVideo` cannot catch that -- it enumerates video stream types only and
// reports nothing about sound -- which is why `probeAudio` exists.
//
// usage: node velocity/scripts/audio-check.mjs

import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const velocity = require(path.resolve(here, '..', 'index.js'))

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiocheck-'))
const screenPath = path.join(workDir, 'rec.mp4')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

console.log('recording 6s with system audio\n')
const stopper = velocity.startMonitorRecordingV2({
  outputPath: screenPath,
  bitrate: 8_000_000,
  includeSystemAudio: true,
  targetFps: 30,
  enableWebcam: false,
})
await sleep(6000)
stopper.stop()

const probe = velocity.probeVideo(screenPath)
console.log('source native types:', probe.nativeTypes.join(' | ') || '(none)')

const info = new velocity.VideoDecoder(screenPath).info()
console.log(`source duration ${info.duration.toFixed(0)}ms\n`)

async function run(label, audioSources) {
  const out = path.join(workDir, `${label}.mp4`)
  const exporter = new velocity.VideoExporter(screenPath, {
    output: out,
    bitrate: 8_000_000,
    audioSources,
  })
  let p = exporter.progress()
  while (!p.finished) {
    await sleep(120)
    p = exporter.progress()
    if (p.error) break
  }
  const size = fs.existsSync(out) ? fs.statSync(out).size : 0
  return { out, size, error: p.error, frames: p.framesDone }
}

console.log('export')
const silent = await run('silent', [])
check('silent export finished', !silent.error && silent.frames > 0, silent.error ?? `${silent.frames} frames`)

const withAudio = await run('withaudio', [{ path: screenPath, offsetMs: 0 }])
check(
  'export with audio finished',
  !withAudio.error && withAudio.frames > 0,
  withAudio.error ?? `${withAudio.frames} frames`,
)

console.log('\noutput')

// The decisive test: does the exported file have a decodable audio track?
const silentAudio = velocity.probeAudio(silent.out)
const mixedAudio = velocity.probeAudio(withAudio.out)

console.log(`  silent export:     ${JSON.stringify(silentAudio)}`)
console.log(`  with-audio export: ${JSON.stringify(mixedAudio)}`)

check('a silent export has no audio track', !silentAudio.hasAudio)
check('an export with sources has an audio track', mixedAudio.hasAudio)
check(
  'the exported audio is stereo at the mix rate',
  mixedAudio.channels === 2 && mixedAudio.sampleRate === 48000,
  `${mixedAudio.channels}ch @ ${mixedAudio.sampleRate}Hz`,
)
check(
  'the audio track is about as long as the video',
  Math.abs(mixedAudio.duration - info.duration) < 500,
  `audio ${mixedAudio.duration.toFixed(0)}ms vs video ${info.duration.toFixed(0)}ms`,
)
check(
  'the file with audio is larger than the one without',
  withAudio.size > silent.size,
  `${withAudio.size} vs ${silent.size} bytes`,
)

fs.rmSync(workDir, { recursive: true, force: true })
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
