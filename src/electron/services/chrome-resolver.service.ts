import { app } from 'electron';

import { ensureBrowser } from '@remotion/renderer';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves the Chrome executable path for Remotion rendering.
 *
 * Strategies:
 * 1. Production (Packaged):
 *    - Check for bundled Chrome in resources/chrome.
 *    - If found, return it.
 *    - If not found (error state), fall back to download.
 *
 * 2. Development:
 *    - Use ensureBrowser() to download/cache in default location.
 */

let cachedChromePath: string | null = null;

export async function ensureChromeBrowser(): Promise<string> {
  if (cachedChromePath) {
    return cachedChromePath;
  }

  console.log('[chrome-resolver] Ensuring Chrome is available for Remotion...');

  // 1. Check for bundled Chrome in Production
  if (app.isPackaged) {
    console.log('[chrome-resolver] Running in PRODUCTION mode. Checking for bundled Chrome...');

    // Path structure: resources/chrome/chrome.exe (Windows)
    // We start looking in process.resourcesPath/chrome
    const bundledChromeDir = path.join(process.resourcesPath, 'chrome');

    // We need to find the executable inside this directory.
    // It might be directly in 'chrome', or within a subdir like 'chrome-win' depending on how it was copied.
    // Let's recursively search or check common locations.

    const possibleExecutables = [
      path.join(bundledChromeDir, 'chrome.exe'),
      path.join(bundledChromeDir, 'chrome-headless-shell.exe'),
      path.join(bundledChromeDir, 'chrome-win', 'chrome.exe'),
      path.join(bundledChromeDir, 'chrome-win64', 'chrome.exe'),
    ];

    for (const execPath of possibleExecutables) {
      if (fs.existsSync(execPath)) {
        console.log(`[chrome-resolver] Found bundled Chrome at: ${execPath}`);
        cachedChromePath = execPath;
        return execPath;
      }
    }

    console.warn(
      '[chrome-resolver] Bundled Chrome NOT FOUND. Falling back to ensureBrowser (download)...',
    );
  }

  // 2. Development or Fallback
  const status = await ensureBrowser({
    logLevel: 'info',
  });

  if (status.type === 'no-browser' || status.type === 'version-mismatch') {
    throw new Error(`[chrome-resolver] Failed to ensure Chrome browser. Status: ${status.type}`);
  }

  cachedChromePath = status.path;
  console.log(`[chrome-resolver] Chrome resolved at: ${cachedChromePath}`);

  return cachedChromePath;
}
