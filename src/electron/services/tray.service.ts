/**
 * TrayService — quick overview:
 * - Creates and manages the system tray icon with context menu.
 * - Handles show/hide app from tray, click interactions, and clean icon loading.
 *
 * Key exports:
 *   createTray(mainWindow)    → Initialize tray with icon and context menu
 *   hideToTray(mainWindow)    → Hide window to tray
 *   getTray()                 → Get current Tray instance
 */

import { app, type BrowserWindow, Menu, nativeImage, Tray } from 'electron';

import path from 'path';

import { isDevelopment } from '../util.js';

let tray: Tray | null = null;

function getIconPath(): string {
  if (isDevelopment()) {
    // In dev, the working directory is the project root
    return path.join(process.cwd(), 'public', 'R.png');
  } else {
    // In production, public is in extraResources
    return path.join(process.resourcesPath, 'public', 'R.png');
  }
}

export function createTray(mainWindow: BrowserWindow) {
  const iconPath = getIconPath();
  console.log('Loading tray icon from:', iconPath);

  // Create icon - use a fallback if the image doesn't load
  let icon = nativeImage.createFromPath(iconPath);

  // If icon is empty, log error
  if (icon.isEmpty()) {
    console.error(`Tray icon not found at: ${iconPath}`);
    // Create a simple 16x16 fallback icon
    icon = nativeImage.createEmpty();
  } else {
    icon = icon.resize({ width: 16, height: 16 });
  }

  tray = new Tray(icon);
  tray.setToolTip('Recso - Screen Recorder');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show App',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Click on tray icon to show window
  tray.on('click', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Double-click also shows
  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  return tray;
}

export function hideToTray(mainWindow: BrowserWindow) {
  mainWindow.hide();
}

export function getTray() {
  return tray;
}
