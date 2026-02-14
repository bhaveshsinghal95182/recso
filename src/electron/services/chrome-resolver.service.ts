import { ensureBrowser } from '@remotion/renderer';

/**
 * Resolves the Chrome executable path for Remotion rendering.
 *
 * Uses Remotion's built-in ensureBrowser() which:
 * - Downloads the correct Chrome version on first use (~150-200MB)
 * - Caches it in node_modules/.remotion/ (dev) or equivalent
 * - Validates version on subsequent calls (instant if up-to-date)
 * - Returns the absolute path to the executable
 *
 * The returned path can be passed directly to renderMedia({ browserExecutable: ... })
 */

let cachedChromePath: string | null = null;

export async function ensureChromeBrowser(): Promise<string> {
  if (cachedChromePath) {
    return cachedChromePath;
  }

  console.log('[chrome-resolver] Ensuring Chrome is available for Remotion...');

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
