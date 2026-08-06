#!/usr/bin/env node
// Velocity CLI — manual + scriptable testing surface for the velocity native addon.
//
// Usage:
//   node cli/velocity-cli.mjs <command> [options]
//   pnpm cli -- <command> [options]
//
// Run `node cli/velocity-cli.mjs help` for the full command reference.

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

import { flagAsBool, flagAsInt, flagAsString, parseArgs } from './lib/args.mjs'
import { dim, fail, formatBytes, formatMs, heading, ok, renderTable, warn } from './lib/format.mjs'
import { CliError, loadVelocity, packageRoot } from './lib/native.mjs'

const DEFAULT_BITRATE = 8_000_000
const DEFAULT_DURATION_MS = 5000
const STOP_SETTLE_MS = 400

function defaultOutputPath(kind) {
  const timestamp = Date.now()
  const dir = path.join(packageRoot, 'tests')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${kind}_${timestamp}.mp4`)
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2))
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

function cmdCheck(velocity, { flags }) {
  const asJson = flagAsBool(flags, 'json')
  const report = {
    nativeAddonLoaded: true,
    packageRoot,
  }

  try {
    report.cursorSettingsSupported = velocity.isCursorSettingsSupported()
  } catch (error) {
    report.cursorSettingsSupported = null
    report.cursorSettingsError = String(error)
  }

  try {
    report.windowCount = velocity.listAvailableWindows().length
  } catch (error) {
    report.windowCount = null
    report.windowError = String(error)
  }

  try {
    report.webcamCount = velocity.listWebcamDevices().length
  } catch (error) {
    report.webcamCount = null
    report.webcamError = String(error)
  }

  if (asJson) {
    printJson(report)
    return
  }

  console.log(heading('Velocity environment check'))
  console.log(`  Native addon:        ${ok('loaded')} (${dim(path.join(packageRoot, 'index.js'))})`)
  console.log(
    `  Cursor settings API:  ${report.cursorSettingsSupported === null ? fail('error') : report.cursorSettingsSupported ? ok('supported') : warn('unsupported on this OS build')}`,
  )
  console.log(`  Capturable windows:   ${report.windowCount === null ? fail('error') : report.windowCount}`)
  console.log(`  Webcam devices:       ${report.webcamCount === null ? fail('error') : report.webcamCount}`)

  if (report.windowError) console.log(`  ${fail('window enumeration error')}: ${report.windowError}`)
  if (report.webcamError) console.log(`  ${fail('webcam enumeration error')}: ${report.webcamError}`)
}

// ---------------------------------------------------------------------------
// list-windows / list-webcams
// ---------------------------------------------------------------------------

function cmdListWindows(velocity, { flags }) {
  const windows = velocity.listAvailableWindows()

  if (flagAsBool(flags, 'json')) {
    printJson(windows)
    return
  }

  console.log(heading(`Capturable windows (${windows.length})`))
  console.log(
    renderTable(
      windows.map((win, index) => ({ ...win, index })),
      [
        { key: 'index', label: '#' },
        { key: 'title', label: 'Title' },
        { key: 'className', label: 'Class' },
        {
          key: 'width',
          label: 'Size',
          format: (_value, row) => `${row.width}x${row.height}`,
        },
        {
          key: 'thumbnailDataUrl',
          label: 'Thumb',
          format: (value) => (value ? ok('yes') : dim('no')),
        },
      ],
    ),
  )
}

function cmdListWebcams(velocity, { flags }) {
  const devices = velocity.listWebcamDevices()

  if (flagAsBool(flags, 'json')) {
    printJson(devices)
    return
  }

  console.log(heading(`Webcam devices (${devices.length})`))
  console.log(
    renderTable(devices, [
      { key: 'id', label: 'Device ID' },
      { key: 'label', label: 'Label' },
      { key: 'isDefault', label: 'Default', format: (value) => (value ? ok('yes') : dim('no')) },
    ]),
  )
}

// ---------------------------------------------------------------------------
// cursor snapshot / cursor samples
// ---------------------------------------------------------------------------

function cmdCursorSnapshot(velocity, { flags }) {
  const snapshot = JSON.parse(velocity.captureCursorSnapshotJson())

  if (flagAsBool(flags, 'json')) {
    printJson(snapshot)
    return
  }

  console.log(heading('Cursor snapshot'))
  console.log(`  Captured at:     ${new Date(snapshot.capturedAtEpochMs).toISOString()}`)
  console.log(`  Cursor info ok:  ${snapshot.cursorInfo.ok ? ok('yes') : fail('no')}`)
  if (snapshot.cursorInfo.ok) {
    console.log(`  System cursor:   ${snapshot.cursorInfo.systemCursorGuess ?? dim('(custom/unrecognized)')}`)
    console.log(`  Showing:         ${snapshot.cursorInfo.isShowing}`)
  }
  console.log(`  Screen pos:      ${snapshot.cursorPos.screenPos?.x ?? '?'}, ${snapshot.cursorPos.screenPos?.y ?? '?'}`)
  console.log(`  Window under:    ${snapshot.windowUnderCursor.found ? snapshot.windowUnderCursor.title || dim('(untitled)') : dim('(none)')}`)
}

async function cmdCursorSamples(velocity, { flags }) {
  const duration = flagAsInt(flags, 'duration', 2000)
  const interval = flagAsInt(flags, 'interval', 16)
  const outPath = flagAsString(flags, 'out', undefined)

  console.log(dim(`Sampling cursor for ${formatMs(duration)} at ${interval}ms intervals...`))
  const payload = JSON.parse(velocity.captureCursorSamplesJson(duration, interval))

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8')
    console.log(ok(`Wrote ${payload.sampleCount} samples to ${outPath}`))
  }

  if (flagAsBool(flags, 'json')) {
    printJson(payload)
    return
  }

  if (!outPath) {
    console.log(heading(`Collected ${payload.sampleCount} samples (durationMs=${payload.durationMs}, intervalMs=${payload.intervalMs})`))
  }
}

// ---------------------------------------------------------------------------
// record monitor / record window
// ---------------------------------------------------------------------------

function buildRecordSummary({ outputPath, cursorPath, startedAt, endedAt }) {
  const summary = {
    outputPath: path.resolve(outputPath),
    outputExists: fs.existsSync(outputPath),
    outputSizeBytes: fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0,
    startedAtEpochMs: startedAt,
    endedAtEpochMs: endedAt,
    durationMs: endedAt - startedAt,
  }
  if (cursorPath) {
    summary.cursorPath = path.resolve(cursorPath)
    summary.cursorExists = fs.existsSync(cursorPath)
  }
  return summary
}

async function runRecording(velocity, { start, outputPath, durationMs, captureCursor }) {
  const startedAt = Date.now()

  let stopper
  try {
    stopper = start()
  } catch (error) {
    // The native addon reports startup failures (missing window, webcam init failure,
    // unusable output path) as thrown JS errors. Surface the message on its own rather
    // than dumping a JS stack trace that says nothing about the actual cause.
    throw new CliError(`Failed to start recording: ${error instanceof Error ? error.message : String(error)}`)
  }

  let cursorPath
  if (captureCursor) {
    cursorPath = `${outputPath.replace(/\.mp4$/i, '')}.cursor.json`
    const chunkMs = Math.min(durationMs, 10_000)
    const samples = []
    const captureStart = Date.now()
    while (Date.now() - captureStart < durationMs) {
      const chunk = JSON.parse(velocity.captureCursorSamplesJson(chunkMs, 16))
      samples.push(...chunk.samples)
    }
    fs.writeFileSync(cursorPath, JSON.stringify({ sampleCount: samples.length, samples }, null, 2), 'utf-8')
  } else {
    await wait(durationMs)
  }

  stopper.stop()
  await wait(STOP_SETTLE_MS)
  const endedAt = Date.now()

  return buildRecordSummary({ outputPath, cursorPath, startedAt, endedAt })
}

function printRecordSummary(summary, asJson) {
  if (asJson) {
    printJson(summary)
    return
  }

  if (summary.outputExists && summary.outputSizeBytes > 0) {
    console.log(ok(`Recording saved: ${summary.outputPath} (${formatBytes(summary.outputSizeBytes)})`))
  } else {
    console.log(fail(`Recording file missing or empty: ${summary.outputPath}`))
  }
  if (summary.cursorPath) {
    console.log(
      summary.cursorExists
        ? ok(`Cursor JSON saved: ${summary.cursorPath}`)
        : fail(`Cursor JSON missing: ${summary.cursorPath}`),
    )
  }
  console.log(dim(`Elapsed: ${formatMs(summary.durationMs)}`))
}

function assertNonEmptyOrExit(summary, flags) {
  if (!flagAsBool(flags, 'assert-non-empty')) return
  if (!summary.outputExists || summary.outputSizeBytes === 0) {
    throw new CliError(`--assert-non-empty: output file is missing or empty (${summary.outputPath})`)
  }
  if (summary.cursorPath && !summary.cursorExists) {
    throw new CliError(`--assert-non-empty: cursor JSON is missing (${summary.cursorPath})`)
  }
}

async function cmdRecordMonitor(velocity, { flags }) {
  const outputPath = flagAsString(flags, 'output', undefined) ?? defaultOutputPath('monitor')
  const duration = flagAsInt(flags, 'duration', DEFAULT_DURATION_MS)
  const bitrate = flagAsInt(flags, 'bitrate', DEFAULT_BITRATE)
  const audio = flagAsBool(flags, 'audio')
  const useV1 = flagAsBool(flags, 'v1')
  const captureCursor = flagAsBool(flags, 'cursor')
  const fps = flagAsInt(flags, 'fps', 60)
  const webcamFlag = flags.webcam

  console.log(dim(`Recording primary monitor for ${formatMs(duration)} -> ${outputPath}`))
  if (webcamFlag) console.log(dim('Webcam overlay enabled'))

  const start = () => {
    if (useV1) {
      return velocity.startMonitorRecording(outputPath, bitrate, audio)
    }
    return velocity.startMonitorRecordingV2({
      outputPath,
      bitrate,
      includeSystemAudio: audio,
      targetFps: fps,
      enableWebcam: Boolean(webcamFlag),
      webcamDeviceId: typeof webcamFlag === 'string' ? webcamFlag : undefined,
    })
  }

  const summary = await runRecording(velocity, { start, outputPath, durationMs: duration, captureCursor })
  printRecordSummary(summary, flagAsBool(flags, 'json'))
  assertNonEmptyOrExit(summary, flags)
}

async function cmdRecordWindow(velocity, { flags }) {
  const title = flagAsString(flags, 'title', undefined)
  if (!title) {
    throw new CliError('record window requires --title "<substring of the window title>"')
  }

  const outputPath = flagAsString(flags, 'output', undefined) ?? defaultOutputPath('window')
  const duration = flagAsInt(flags, 'duration', DEFAULT_DURATION_MS)
  const bitrate = flagAsInt(flags, 'bitrate', DEFAULT_BITRATE)
  const audio = flagAsBool(flags, 'audio')
  const useV1 = flagAsBool(flags, 'v1')
  const captureCursor = flagAsBool(flags, 'cursor')
  const fps = flagAsInt(flags, 'fps', 60)
  const webcamFlag = flags.webcam

  console.log(dim(`Recording window matching "${title}" for ${formatMs(duration)} -> ${outputPath}`))
  console.log(warn('Note: this will steal foreground focus from the target window.'))

  const start = () => {
    if (useV1) {
      return velocity.startWindowRecording(title, outputPath, bitrate, audio)
    }
    return velocity.startWindowRecordingV2({
      windowTitle: title,
      outputPath,
      bitrate,
      includeSystemAudio: audio,
      targetFps: fps,
      enableWebcam: Boolean(webcamFlag),
      webcamDeviceId: typeof webcamFlag === 'string' ? webcamFlag : undefined,
    })
  }

  const summary = await runRecording(velocity, { start, outputPath, durationMs: duration, captureCursor })
  printRecordSummary(summary, flagAsBool(flags, 'json'))
  assertNonEmptyOrExit(summary, flags)
}

// ---------------------------------------------------------------------------
// interactive (legacy prompt-driven picker, formerly tests/test-runner.js)
// ---------------------------------------------------------------------------

async function cmdInteractive(velocity) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve))

  try {
    console.log(heading('Velocity Interactive Recorder\n'))

    const sources = []
    sources.push({ type: 'monitor_v2', name: 'Entire Screen (Monitor V2 API - supports webcam & fps)' })

    for (const win of velocity.listAvailableWindows()) {
      sources.push({ type: 'window', name: win.title, data: win })
    }

    if (sources.length === 0) {
      console.log(fail('No recording sources found.'))
      return
    }

    console.log('Available sources:\n')
    sources.forEach((s, i) => console.log(`  ${i + 1}. ${s.name} (${s.type})`))

    const answer = await question('\nSelect source number: ')
    const selected = sources[Number.parseInt(answer, 10) - 1]
    if (!selected) {
      console.log(fail('Invalid selection'))
      return
    }

    let enableWebcam = false
    let webcamDeviceId
    if (selected.type === 'monitor_v2') {
      const webcams = velocity.listWebcamDevices()
      if (webcams.length > 0) {
        console.log('\nAvailable webcams:')
        console.log('  0. None (do not record webcam)')
        webcams.forEach((cam, i) => console.log(`  ${i + 1}. ${cam.label}${cam.isDefault ? ' (default)' : ''}`))
        const camAnswer = await question('\nSelect webcam number (0 to skip): ')
        const camIndex = Number.parseInt(camAnswer, 10) - 1
        if (camIndex >= 0 && camIndex < webcams.length) {
          enableWebcam = true
          webcamDeviceId = webcams[camIndex].id
        }
      }
    }

    const durationAnswer = await question('\nRecord for how many seconds? [10]: ')
    const durationMs = (Number.parseInt(durationAnswer, 10) || 10) * 1000

    const outputPath = defaultOutputPath(selected.type === 'window' ? 'window' : 'monitor')
    console.log(`\n${dim(`Recording -> ${outputPath}`)}`)

    const start = () => {
      if (selected.type === 'window') {
        return velocity.startWindowRecordingV2({
          windowTitle: selected.data.title,
          outputPath,
          bitrate: DEFAULT_BITRATE,
          includeSystemAudio: true,
          targetFps: 60,
          enableWebcam,
          webcamDeviceId,
        })
      }
      return velocity.startMonitorRecordingV2({
        outputPath,
        bitrate: DEFAULT_BITRATE,
        includeSystemAudio: true,
        targetFps: 60,
        enableWebcam,
        webcamDeviceId,
      })
    }

    const summary = await runRecording(velocity, { start, outputPath, durationMs, captureCursor: true })
    printRecordSummary(summary, false)
  } finally {
    rl.close()
  }
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

const HELP = `
${heading('velocity-cli')} — manual + scriptable testing surface for the velocity native addon

${heading('Usage')}
  node cli/velocity-cli.mjs <command> [options]

${heading('Commands')}
  check                          Environment diagnostics (addon loads, API availability, counts)
  list-windows [--json]          List capturable windows
  list-webcams [--json]          List webcam devices
  cursor snapshot [--json]       Print one cursor snapshot
  cursor samples [options]       Sample the cursor over a duration
      --duration <ms>              Sample duration (default 2000, clamped to [20, 60000] natively)
      --interval <ms>              Sample interval (default 16, clamped to [1, 1000] natively)
      --out <file>                 Write JSON to a file instead of / in addition to stdout
      --json                       Print raw JSON payload to stdout
  record monitor [options]       Record the primary monitor
  record window --title <t> [..] Record the first window whose title contains <t>
      --output <file>               Output .mp4 path (default: tests/<kind>_<timestamp>.mp4)
      --duration <ms>               Recording duration in ms (default 5000)
      --bitrate <bps>               Video bitrate (default 8000000)
      --fps <30|60>                 Target FPS, v2 API only (default 60)
      --audio                       Include system loopback audio
      --webcam [deviceId]           Enable webcam overlay sidecar (v2 API only)
      --cursor                      Also capture cursor samples JSON alongside the recording
      --v1                          Use the legacy v1 API (no fps/webcam support)
      --assert-non-empty            Exit with code 1 if the output ends up missing/empty (CI use)
      --json                        Print a machine-readable JSON summary instead of formatted text
  interactive                    Legacy interactive picker (prompts for source/webcam/duration)
  help                            Show this message

${heading('Examples')}
  node cli/velocity-cli.mjs check
  node cli/velocity-cli.mjs list-windows --json
  node cli/velocity-cli.mjs cursor samples --duration 3000 --out samples.json
  node cli/velocity-cli.mjs record monitor --duration 4000 --audio --output out.mp4
  node cli/velocity-cli.mjs record window --title Notepad --webcam --assert-non-empty
`

function printHelp() {
  console.log(HELP)
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

async function main() {
  const [command, subcommand, ...rest] = process.argv.slice(2)

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return
  }

  const velocity = loadVelocity()

  if (command === 'check') {
    cmdCheck(velocity, parseArgs([subcommand, ...rest].filter(Boolean)))
    return
  }

  if (command === 'list-windows') {
    cmdListWindows(velocity, parseArgs([subcommand, ...rest].filter(Boolean)))
    return
  }

  if (command === 'list-webcams') {
    cmdListWebcams(velocity, parseArgs([subcommand, ...rest].filter(Boolean)))
    return
  }

  if (command === 'cursor') {
    const parsed = parseArgs(rest)
    if (subcommand === 'snapshot') return cmdCursorSnapshot(velocity, parsed)
    if (subcommand === 'samples') return cmdCursorSamples(velocity, parsed)
    throw new CliError(`Unknown cursor subcommand: ${subcommand ?? '(none)'}. Expected "snapshot" or "samples".`)
  }

  if (command === 'record') {
    const parsed = parseArgs(rest)
    if (subcommand === 'monitor') return cmdRecordMonitor(velocity, parsed)
    if (subcommand === 'window') return cmdRecordWindow(velocity, parsed)
    throw new CliError(`Unknown record subcommand: ${subcommand ?? '(none)'}. Expected "monitor" or "window".`)
  }

  if (command === 'interactive') {
    return cmdInteractive(velocity)
  }

  throw new CliError(`Unknown command: ${command}\nRun "node cli/velocity-cli.mjs help" for usage.`)
}

main().catch((error) => {
  if (error instanceof CliError) {
    console.error(fail(`\nError: ${error.message}`))
    process.exitCode = error.exitCode
    return
  }
  console.error(fail('\nUnexpected error:'), error)
  process.exitCode = 1
})
