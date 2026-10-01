/**
 * Which builds update themselves.
 *
 * - The NSIS install (Windows) and the AppImage (Linux) do, through
 *   electron-updater and the feeds each release publishes.
 * - The Microsoft Store build updates through the Store, and the deb through
 *   the package manager; replacing their files would fight their owner.
 * - A development run has nothing to update.
 */

export type UpdateSupport =
  | { supported: true }
  | { supported: false; reason: 'development' | 'windows-store' | 'linux-package' | 'platform' };

export function updateSupport(env: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  /** Electron's `process.windowsStore`: true in the AppX build. */
  windowsStore: boolean;
  /** `$APPIMAGE`, the AppImage's own path, set only when running from one. */
  appImage: string | undefined;
}): UpdateSupport {
  if (!env.isPackaged) return { supported: false, reason: 'development' };
  if (env.platform === 'win32') {
    return env.windowsStore ? { supported: false, reason: 'windows-store' } : { supported: true };
  }
  if (env.platform === 'linux') {
    return env.appImage ? { supported: true } : { supported: false, reason: 'linux-package' };
  }
  return { supported: false, reason: 'platform' };
}
