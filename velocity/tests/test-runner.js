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

    // List all exports
    const exportsList = Object.keys(velocity)
    console.log(exportsList)

    // Test: listAvailableWindows
    let windowTitle = null
    if (typeof velocity.listAvailableWindows === 'function') {
      console.log('\n🪟 Testing listAvailableWindows()...')
      const windows = velocity.listAvailableWindows()
      console.log(`   ✅ Found ${windows.length} windows:`)
      windows.forEach((w, i) => {
        console.log(`      ${i + 1}. "${w.title}" [${w.className}]`)
      })
      if (windows.length > 0) {
        windowTitle = windows[2].title
      }
    } else {
      console.log('\n⚠️ listAvailableWindows not found.')
    }

    // Test: Monitor Recording API
    if (typeof velocity.startMonitorRecording === 'function') {
      console.log(`\n🎥 Testing Monitor Recording API...`)
      const outputPath = 'tests/test_recording.mp4'
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath)
      }

      const bitrate = 50000000
      const stopper = velocity.startMonitorRecording(outputPath, bitrate)
      console.log('   ✅ Recording started! Waiting 3.5 seconds...')

      await new Promise((resolve) => setTimeout(resolve, 3500))

      console.log('   🛑 Sending STOP signal through IPC...')
      stopper.stop()

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

    // Test: Window Recording API
    if (typeof velocity.startWindowRecording === 'function' && windowTitle) {
      console.log(`\n🎯 Testing Window Recording API (capturing: "${windowTitle}")...`)
      const outputPath = 'tests/test_window_recording.mp4'
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath)
      }

      const bitrate = 50000000
      const stopper = velocity.startWindowRecording(windowTitle, outputPath, bitrate)
      console.log('   ✅ Window recording started! Waiting 3.5 seconds...')

      await new Promise((resolve) => setTimeout(resolve, 3500))

      console.log('   🛑 Sending STOP signal through IPC...')
      stopper.stop()

      await new Promise((resolve) => setTimeout(resolve, 500))

      if (fs.existsSync(outputPath)) {
        const stats = fs.statSync(outputPath)
        console.log(`   ✅ Window video saved successfully! Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`)
      } else {
        console.log('   ❌ Window video file was not found where expected!')
      }
    } else if (!windowTitle) {
      console.log('\n⚠️ Skipping window recording test — no windows found.')
    } else {
      console.log('\n⚠️ startWindowRecording not found.')
    }
  } catch (error) {
    console.error('\n❌ Error occurred during execution:', error)
  }

  console.log('\n--- Testing Complete ---')
}

runTests()
