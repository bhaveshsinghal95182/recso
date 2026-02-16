import { ensureBrowser } from '@remotion/renderer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const start = async () => {
  console.log('Downloading/Ensuring Chrome for Remotion bundle...');

  try {
    // 1. Ensure Chrome is downloaded (uses Remotion's default cache)
    const browser = await ensureBrowser({
      logLevel: 'verbose',
    });

    if (browser.type === 'no-browser' || browser.type === 'version-mismatch') {
      throw new Error(`Failed to ensure browser: ${browser.type}`);
    }

    const chromePath = browser.path;
    console.log('Chrome located at:', chromePath);

    // 2. Identify source directory (parent of executable)
    const sourceDir = path.dirname(chromePath);
    const chromeFileName = path.basename(chromePath);

    console.log('Source Directory:', sourceDir);
    console.log('Executable Name:', chromeFileName);

    // 3. Define destination: <project-root>/resources/chrome
    const rootDir = path.resolve(__dirname, '..');
    const resourcesDir = path.join(rootDir, 'resources');
    const destDir = path.join(resourcesDir, 'chrome');

    console.log('Bundling to:', destDir);

    // 4. Clean and Copy
    if (fs.existsSync(destDir)) {
      console.log('Removing existing bundle...');
      fs.rmSync(destDir, { recursive: true, force: true });
    }

    fs.mkdirSync(destDir, { recursive: true });

    console.log('Copying Chrome files (this may take a moment)...');
    fs.cpSync(sourceDir, destDir, { recursive: true });

    // Also optimize: remove unnecessary files if possible?
    // For now, copy everything to be safe.

    console.log('Chrome bundled successfully!');
    console.log(`Executable will be at: resources/chrome/${chromeFileName}`);
  } catch (err) {
    console.error('Failed to bundle Chrome:', err);
    process.exit(1);
  }
};

start();
