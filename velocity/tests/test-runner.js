// test-runner.js
// Interactive CLI to record from selected source

const velocity = require('../index.js')
const fs = require('fs')
const path = require('path')
const readline = require('readline')

const RECORD_DURATION = 1000 * 60 * 5 // 5 minutes
const BITRATE = 50000000
const CURSOR_SAMPLE_INTERVAL_MS = 16

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve)
  })
}

async function listSources() {
  const sources = []

  // 1. Explicit option for Entire Screen using V2 (Supports Webcam & FPS limits)
  if (typeof velocity.startMonitorRecordingV2 === 'function') {
    sources.push({
      index: sources.length,
      type: 'monitor_v2',
      name: 'Entire Screen (Monitor V2 API - Supports Webcam)',
      data: { description: 'Full screen recording using V2 API options' },
    })
  }

  // 2. Get monitors (Legacy/Fallback)
  if (typeof velocity.listAvailableMonitors === 'function') {
    try {
      const monitors = velocity.listAvailableMonitors()
      monitors.forEach((m, i) => {
        sources.push({
          index: sources.length,
          type: 'monitor',
          name: `Monitor ${i + 1} (Legacy)`,
          data: m,
        })
      })
    } catch (e) {
      // Monitor listing failed, continue
    }
  }

  // 3. Get windows
  if (typeof velocity.listAvailableWindows === 'function') {
    try {
      const windows = velocity.listAvailableWindows()
      windows.forEach((w, i) => {
        sources.push({
          index: sources.length,
          type: 'window',
          name: w.title || `Window ${i + 1}`,
          data: w,
        })
      })
    } catch (e) {
      // Window listing failed, continue
    }
  }

  return sources
}

async function recordSource(source, duration, enableWebcam = false, webcamDeviceId = undefined) {
  const timestamp = Date.now()
  const recordingBaseName = `recording_${timestamp}`
  const outputPath = `tests/${recordingBaseName}.mp4`
  const cursorOutputPath = `tests/${recordingBaseName}.cursor.json`

  // Create tests directory if it doesn't exist
  if (!fs.existsSync('tests')) {
    fs.mkdirSync('tests', { recursive: true })
  }

  console.log(`\n🎥 Recording "${source.name}" for ${duration / 1000} seconds...`)
  if (enableWebcam) {
    console.log(`📷 Webcam overlay enabled!`)
  }

  try {
    let stopper

    // Switch between recording methods based on the selected type
    if (source.type === 'monitor_v2') {
      stopper = velocity.startMonitorRecordingV2({
        outputPath: outputPath,
        bitrate: BITRATE,
        includeSystemAudio: true,
        targetFps: 60,
        enableWebcam: enableWebcam,
        webcamDeviceId: webcamDeviceId,
      })
    } else if (source.type === 'monitor') {
      stopper = velocity.startMonitorRecording(outputPath, BITRATE)
    } else if (source.type === 'window') {
      stopper = velocity.startWindowRecording(source.data.title, outputPath, BITRATE)
    }

    const cursorCaptureAvailable = typeof velocity.captureCursorSamplesJson === 'function'

    if (cursorCaptureAvailable) {
      console.log(`🖱️ Capturing cursor snapshots in chunks for ${duration / 1000}s...`)

      const captureStartedAt = Date.now()
      const CHUNK_DURATION = 10000 // 10 seconds per chunk
      let allSamples = []

      // Loop until the total requested duration has passed
      while (Date.now() - captureStartedAt < duration) {
        const chunkJson = velocity.captureCursorSamplesJson(CHUNK_DURATION, CURSOR_SAMPLE_INTERVAL_MS)
        try {
          const parsed = JSON.parse(chunkJson)

          // If it's an array, merge the items. If it's an object, push the whole object.
          if (Array.isArray(parsed)) {
            allSamples = allSamples.concat(parsed)
          } else {
            allSamples.push(parsed)
          }
        } catch (err) {
          console.log('⚠️ Failed to parse a cursor chunk:', err.message)
        }
      }

      const captureEndedAt = Date.now()

      const cursorPayload = {
        recording: {
          id: recordingBaseName,
          outputPath: path.resolve(outputPath),
          sourceType: source.type,
          sourceName: source.name,
          sourceDetails: source.data,
          startedAtEpochMs: captureStartedAt,
          endedAtEpochMs: captureEndedAt,
          requestedDurationMs: duration,
          actualCaptureDurationMs: captureEndedAt - captureStartedAt,
          webcamEnabled: enableWebcam,
        },
        cursorCapture: allSamples,
      }

      fs.writeFileSync(cursorOutputPath, JSON.stringify(cursorPayload, null, 2), 'utf-8')
      console.log(`🧾 Cursor data saved: ${cursorOutputPath}`)
    } else {
      console.log('ℹ️ captureCursorSamplesJson is not available in this velocity build; skipping cursor JSON capture.')
      await new Promise((resolve) => setTimeout(resolve, duration))
    }

    console.log('🛑 Stopping recording...')
    if (stopper && typeof stopper.stop === 'function') {
      stopper.stop()
    } else {
      console.log('⚠️ Warning: No valid stopper returned from native module.')
    }

    // Wait a bit for file to finalize
    await new Promise((resolve) => setTimeout(resolve, 500))

    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath)
      const sizeInMB = (stats.size / 1024 / 1024).toFixed(2)
      console.log(`✅ Recording saved: ${outputPath} (${sizeInMB} MB)`)
      if (fs.existsSync(cursorOutputPath)) {
        const cursorStats = fs.statSync(cursorOutputPath)
        const cursorSizeKB = (cursorStats.size / 1024).toFixed(1)
        console.log(`✅ Cursor JSON saved: ${cursorOutputPath} (${cursorSizeKB} KB)`)
      }
    } else {
      console.log('❌ Recording file not found!')
    }
  } catch (error) {
    console.error('❌ Recording failed:', error.message)
  }
}

async function main() {
  console.log('🎬 Velocity Recording CLI\n')

  try {
    const sources = await listSources()

    if (sources.length === 0) {
      console.log('❌ No recording sources found!')
      rl.close()
      return
    }

    console.log('Available sources:\n')
    sources.forEach((s) => {
      console.log(`  ${s.index + 1}. ${s.name} (${s.type})`)
    })

    const answer = await question('\nSelect source number: ')
    const selectedIndex = parseInt(answer) - 1

    if (selectedIndex < 0 || selectedIndex >= sources.length) {
      console.log('❌ Invalid selection')
      rl.close()
      return
    }

    const selected = sources[selectedIndex]

    // Check for webcams if the user chose the Monitor V2 option
    let enableWebcam = false
    let webcamDeviceId = undefined

    if (selected.type === 'monitor_v2' && typeof velocity.listWebcamDevices === 'function') {
      try {
        const webcams = velocity.listWebcamDevices()
        if (webcams && webcams.length > 0) {
          console.log('\nAvailable Webcams:')
          console.log('  0. None (Do not record webcam)')
          webcams.forEach((cam, i) => {
            console.log(`  ${i + 1}. ${cam.label || 'Unknown Device'} ${cam.isDefault ? '(Default)' : ''}`)
          })

          const camAnswer = await question('\nSelect webcam number (0 to skip): ')
          const camIndex = parseInt(camAnswer) - 1

          if (camIndex >= 0 && camIndex < webcams.length) {
            enableWebcam = true
            webcamDeviceId = webcams[camIndex].id
          }
        }
      } catch (e) {
        console.log('⚠️ Failed to list webcams, continuing without it:', e.message)
      }
    }

    await recordSource(selected, RECORD_DURATION, enableWebcam, webcamDeviceId)
  } catch (error) {
    console.error('❌ Error:', error.message)
  } finally {
    rl.close()
  }
}

main()
