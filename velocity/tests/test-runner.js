// test-runner.js
// A simple scratchpad to test functions exposed from the Rust/NAPI module

const velocity = require('../index.js')
const fs = require('fs')

console.log('--- Velocity NAPI Module Test ---')

// List out all exported functions/objects to see what's available
console.log('\nAvailable Exports:')
console.log(Object.keys(velocity))

console.log('\n--- Running Tests ---\n')

async function runTests() {
  try {
    // Test: isCursorSettingsSupported
    if (typeof velocity.isCursorSettingsSupported === 'function') {
      const isSupported = velocity.isCursorSettingsSupported()
      console.log('✅ isCursorSettingsSupported():', isSupported)
    } else {
      console.log('⚠️ isCursorSettingsSupported not found.')
    }

    // Test: listAvailableWindows & startWindowRecording
    let targetWindow = null

    if (typeof velocity.listAvailableWindows === 'function') {
      const windows = velocity.listAvailableWindows()
      console.log(`✅ listAvailableWindows(): Found ${windows.length} windows.`)

      if (windows.length > 0) {
        console.log('   Sample windows:')
        windows.forEach((win, i) => {
          console.log(`   ${i + 1}. "${win.title}" (class: ${win.className})`)
        })

        targetWindow = windows[1]
      }
    } else {
      console.log('⚠️ listAvailableWindows not found.')
    }

    // Test: Recording API
    if (typeof velocity.startMonitorRecording === 'function') {
      console.log(`\n🎥 Testing Monitor Recording API...`)
      const outputPath = 'tests/test_recording.mp4'
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath)
      }

      const stopper = velocity.startMonitorRecording(outputPath)
      console.log('   ✅ Recording started! Waiting 3.5 seconds...')

      await new Promise((resolve) => setTimeout(resolve, 3500))

      console.log('   🛑 Sending STOP signal through IPC...')
      stopper.stop()

      // Wait a tiny bit for the file system to flush
      await new Promise((resolve) => setTimeout(resolve, 500))

      if (fs.existsSync(outputPath)) {
        const stats = fs.statSync(outputPath)
        console.log(`   ✅ Video file saved successfully! Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`)
      } else {
        console.log('   ❌ Video file was not found where expected!')
      }
    } else {
      console.log('\n⚠️ startMonitorRecording not found.')
    }
  } catch (error) {
    console.error('\n❌ Error occurred during execution:', error)
  }

  console.log('\n--- Testing Complete ---')
}

runTests()
