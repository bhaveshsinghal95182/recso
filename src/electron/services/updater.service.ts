/**
 * UpdaterService — quick overview:
 * - Keeps the installed app current through electron-updater, reading the
 *   feed electron-builder publishes with each release (latest.yml on Windows,
 *   latest-linux.yml for the AppImage).
 * - Downloads in the background; once an update is ready, offers a restart
 *   through a notification and the tray menu. Otherwise it installs on quit.
 * - Only builds that can update themselves check (see update-support.ts).
 *   Nothing here throws: a failed check is logged and tried again later.
 *
 * Key exports:
 *   startAutoUpdates()     → Check now and every few hours
 */

import { app, Notification } from 'electron';

import electronUpdater from 'electron-updater';

import { logger } from '../utils/logger.js';
import { setTrayUpdateReady } from './tray.service.js';
import { updateSupport } from './update-support.js';

/** How often a running app looks for a newer release. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let started = false;

function checkQuietly(): void {
  try {
    electronUpdater.autoUpdater.checkForUpdates().catch((error: unknown) => {
      logger.warn('[Updater] Update check failed:', error);
    });
  } catch (error) {
    logger.warn('[Updater] Update check failed:', error);
  }
}

function offerRestart(version: string): void {
  const restart = () => electronUpdater.autoUpdater.quitAndInstall();
  setTrayUpdateReady(version, restart);
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: `Recso ${version} is ready`,
    body: 'Click to restart and update. Otherwise it updates the next time you quit.',
  });
  notification.on('click', restart);
  notification.show();
}

export function startAutoUpdates(): void {
  if (started) return;
  const support = updateSupport({
    isPackaged: app.isPackaged,
    platform: process.platform,
    windowsStore: Boolean(process.windowsStore),
    appImage: process.env.APPIMAGE,
  });
  if (!support.supported) {
    logger.info(`[Updater] Not checking for updates (${support.reason})`);
    return;
  }
  started = true;

  try {
    const { autoUpdater } = electronUpdater;
    autoUpdater.logger = logger;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('error', (error) => logger.warn('[Updater] Update failed:', error));
    autoUpdater.on('update-downloaded', (info) => {
      logger.info(`[Updater] Recso ${info.version} downloaded`);
      try {
        offerRestart(info.version);
      } catch (error) {
        logger.warn('[Updater] Could not offer the restart:', error);
      }
    });

    checkQuietly();
    setInterval(checkQuietly, CHECK_INTERVAL_MS).unref();
  } catch (error) {
    logger.warn('[Updater] Could not start update checks:', error);
  }
}
