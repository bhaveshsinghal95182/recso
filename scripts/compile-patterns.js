/**
 * Copy remotion/patterns.ts to electron source tree for TypeScript compilation
 * This is needed because electron code imports from patterns but we can't
 * include patterns in the electron tsconfig without breaking the output structure.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

console.log('[compile-patterns] Copying remotion/patterns.ts to electron source...');

// Source and destination paths
const patternsSource = path.join(projectRoot, 'src', 'remotion', 'patterns.ts');
const electronRemotionDir = path.join(projectRoot, 'src', 'electron', 'remotion');
const patternsTemp = path.join(electronRemotionDir, 'patterns.ts');

// Create directory if it doesn't exist
if (!fs.existsSync(electronRemotionDir)) {
  fs.mkdirSync(electronRemotionDir, { recursive: true });
}

// Copy the file
try {
  fs.copyFileSync(patternsSource, patternsTemp);
  console.log('[compile-patterns] ✓ Copied to:', patternsTemp);
} catch (error) {
  console.error('[compile-patterns] Failed to copy patterns.ts:', error);
  process.exit(1);
}
