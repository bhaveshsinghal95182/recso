// test-runner.js
// A simple scratchpad to test functions exposed from the Rust/NAPI module

const velocity = require('./index.js')

console.log('--- Velocity NAPI Module Test ---')

// List out all exported functions/objects to see what's available
console.log('\nAvailable Exports:')
console.log(Object.keys(velocity))

console.log('\n--- Running Tests ---\n')

try {
  // Test: isCursorSettingsSupported
  if (typeof velocity.isCursorSettingsSupported === 'function') {
    const isSupported = velocity.isCursorSettingsSupported()
    console.log('✅ isCursorSettingsSupported():', isSupported)
  } else {
    console.log('⚠️ isCursorSettingsSupported not found.')
  }

  // Test: listAvailableWindows
  if (typeof velocity.listAvailableWindows === 'function') {
    const windows = velocity.listAvailableWindows()
    console.log(`✅ listAvailableWindows(): Found ${windows.length} windows.`)

    // Optionally log the first few window titles for verification
    if (windows.length > 0) {
      console.log('   Sample windows:')
      windows.forEach((win, i) => {
        console.log(`   ${i + 1}. "${win.title}" (class: ${win.className})`)
      })
    }
  } else {
    console.log('⚠️ listAvailableWindows not found.')
  }

  // Add more function tests here as you write them in lib.rs!
  // Example:
  // const result = velocity.myNewFunction();
  // console.log('myNewFunction():', result);
} catch (error) {
  console.error('\n❌ Error occurred during execution:', error)
}

console.log('\n--- Testing Complete ---')
