// test-runner.js
// Interactive CLI to record from selected source for 5 seconds

const velocity = require('../index.js')
const fs = require('fs')
const path = require('path')
const readline = require('readline')

const RECORD_DURATION = 5000 // 5 seconds
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

  // Get monitors
  if (typeof velocity.listAvailableMonitors === 'function') {
    try {
      const monitors = velocity.listAvailableMonitors()
      monitors.forEach((m, i) => {
        sources.push({
          index: i,
          type: 'monitor',
          name: `Monitor ${i + 1}`,
          data: m,
        })
      })
    } catch (e) {
      // Monitor listing failed, continue
    }
  }

  // Get windows
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

async function recordSource(source, duration) {
  const timestamp = Date.now()
  const recordingBaseName = `recording_${timestamp}`
  const outputPath = `tests/${recordingBaseName}.mp4`
  const cursorOutputPath = `tests/${recordingBaseName}.cursor.json`

  // Create tests directory if it doesn't exist
  if (!fs.existsSync('tests')) {
    fs.mkdirSync('tests', { recursive: true })
  }

  console.log(`\n🎥 Recording "${source.name}" for ${duration / 1000} seconds...`)

  try {
    let stopper
    if (source.type === 'monitor') {
      stopper = velocity.startMonitorRecording(outputPath, BITRATE)
    } else if (source.type === 'window') {
      stopper = velocity.startWindowRecording(source.data.title, outputPath, BITRATE)
    }

    const cursorCaptureAvailable = typeof velocity.captureCursorSamplesJson === 'function'

    if (cursorCaptureAvailable) {
      console.log(`🖱️ Capturing cursor snapshots for ${duration / 1000}s (interval=${CURSOR_SAMPLE_INTERVAL_MS}ms)...`)

      const captureStartedAt = Date.now()
      const samplesJson = velocity.captureCursorSamplesJson(duration, CURSOR_SAMPLE_INTERVAL_MS)
      const captureEndedAt = Date.now()

      let parsedSamples
      try {
        parsedSamples = JSON.parse(samplesJson)
      } catch {
        parsedSamples = {
          parseError: true,
          raw: samplesJson,
        }
      }

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
        },
        cursorCapture: parsedSamples,
      }

      fs.writeFileSync(cursorOutputPath, JSON.stringify(cursorPayload, null, 2), 'utf-8')
      console.log(`🧾 Cursor data saved: ${cursorOutputPath}`)
    } else {
      console.log('ℹ️ captureCursorSamplesJson is not available in this velocity build; skipping cursor JSON capture.')
      await new Promise((resolve) => setTimeout(resolve, duration))
    }

    console.log('🛑 Stopping recording...')
    stopper.stop()

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
    await recordSource(selected, RECORD_DURATION)
  } catch (error) {
    console.error('❌ Error:', error.message)
  } finally {
    rl.close()
  }
}

main()
