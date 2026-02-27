import { bundle } from '@remotion/bundler';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const start = async () => {
  console.log('Bundling Remotion composition...');

  // Navigate up from scripts/ to root
  const rootDir = path.resolve(__dirname, '..');
  const entryPoint = path.join(rootDir, 'src', 'remotion', 'index.tsx');
  const outDir = path.join(rootDir, 'dist-remotion');

  if (!fs.existsSync(entryPoint)) {
    console.error('Entry point not found:', entryPoint);
    process.exit(1);
  }

  console.log('Entry point:', entryPoint);
  console.log('Output dir:', outDir);

  try {
    const bundledPath = await bundle({
      entryPoint,
      // Helper to enable default webpack config if needed,
      // essentially what the renderer service was doing:
      webpackOverride: (config) => config,
    });

    console.log('Bundle created at specific temp path:', bundledPath);

    // Clean output
    if (fs.existsSync(outDir)) {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outDir, { recursive: true });

    // Copy files to dist-remotion
    console.log('Copying to dist-remotion...');
    fs.cpSync(bundledPath, outDir, { recursive: true });

    console.log('Success! Remotion bundle ready in', outDir);
  } catch (e) {
    console.error('Bundling failed:', e);
    process.exit(1);
  }
};

start();
