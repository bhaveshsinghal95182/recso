import path from 'path';
import { defineConfig } from 'vitest/config';

// Deliberately not the app's `vite.config.ts`. These are node-side checks on
// pure logic, so the React and Tailwind plugins are pure overhead -- the alias
// is the only part of that config they need. A suite that renders components
// would want the app config and a DOM environment instead.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // `dist-react` holds built bundles whose dynamic imports the dep scanner
    // chokes on, and `velocity` is a Rust crate with its own test runner.
    exclude: ['**/node_modules/**', 'dist-react/**', 'dist-electron/**', 'velocity/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/ui'),
    },
  },
});
