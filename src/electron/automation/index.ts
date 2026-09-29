/**
 * The Automation API's lifecycle inside recso's main process.
 *
 * Nothing here runs unless the API is turned on: no socket, no pipe, no
 * listener, no settings store. `initializeAutomation` is the only entry point
 * main.ts calls.
 */

import os from 'node:os';

import { app, type BrowserWindow, ipcMain } from 'electron';

import { registerCoreMethods } from './methods/core.js';
import { registerRecordingMethods } from './methods/recording.js';
import { setActiveSettings } from './active-settings.js';
import { createElectronServices } from './electron-services.js';
import { automationEnabled, readStoredEnabled } from './enabled.js';
import { MethodRegistry } from './registry.js';
import { validate } from './schema.js';
import { AutomationServer } from './server.js';
import type { AutomationServices } from './services.js';
import {
  type AutomationSettings,
  defaultSettings,
  SETTING_SCHEMAS,
  SettingsStore,
} from './settings-store.js';
import { transportPath } from './transport.js';

let mainWindowRef: BrowserWindow | null = null;
let server: AutomationServer | null = null;
let settings: SettingsStore | null = null;
let unsubscribeSettings: (() => void) | null = null;

function currentTransport() {
  return transportPath(process.platform, {
    env: process.env,
    username: os.userInfo().username,
    tmpdir: os.tmpdir(),
  });
}

export function registerAllMethods(
  registry: MethodRegistry,
  services: AutomationServices,
): MethodRegistry {
  registerCoreMethods(registry, services);
  registerRecordingMethods(registry, services);
  return registry;
}

function sendToWindow(channel: string, ...args: unknown[]): void {
  const window = mainWindowRef;
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(channel, ...args);
  }
}

async function startServer(): Promise<void> {
  if (server) return;
  const transport = currentTransport();
  const store = new SettingsStore(defaultSettings(app.getPath('videos')));
  const services = createElectronServices({
    getWindow: () => mainWindowRef,
    transportPath: transport.path,
    settings: store,
  });
  const candidate = new AutomationServer({
    registry: registerAllMethods(new MethodRegistry(), services),
    transport,
    log: (message) => console.log(message),
  });
  try {
    await candidate.start();
  } catch (error) {
    // Never fatal: recso works the same without its API.
    console.error('[Automation] Could not start:', error instanceof Error ? error.message : error);
    return;
  }
  server = candidate;
  settings = store;
  setActiveSettings(store);
  unsubscribeSettings = store.onChange(() =>
    sendToWindow('automation:recorder-settings', { active: true, values: store.get() }),
  );
  sendToWindow('automation:recorder-settings', { active: true, values: store.get() });
}

async function stopServer(): Promise<void> {
  const running = server;
  server = null;
  settings = null;
  setActiveSettings(null);
  unsubscribeSettings?.();
  unsubscribeSettings = null;
  await running?.stop();
  sendToWindow('automation:recorder-settings', { active: false });
}

/**
 * The renderer's side of the settings: the recorder UI adopts the API's
 * values and writes its own changes back, but only while the API is on.
 */
function registerRendererBridge(): void {
  ipcMain.handle('automation:get-recorder-settings', () =>
    settings ? { active: true, values: settings.get() } : { active: false },
  );
  ipcMain.handle(
    'automation:set-recorder-settings',
    (_event, patch: Partial<AutomationSettings>) => {
      if (!settings) return { active: false };
      const allowed = Object.fromEntries(
        Object.entries(patch ?? {}).filter(
          ([key, value]) =>
            key in SETTING_SCHEMAS &&
            validate(SETTING_SCHEMAS[key as keyof AutomationSettings], value).length === 0,
        ),
      ) as Partial<AutomationSettings>;
      settings.set(allowed);
      return { active: true, values: settings.get() };
    },
  );
}

/** Start the API if the user turned it on. Call once the main window exists. */
export async function initializeAutomation(mainWindow: BrowserWindow): Promise<void> {
  mainWindowRef = mainWindow;
  registerRendererBridge();
  app.once('will-quit', () => {
    void stopServer();
  });
  if (automationEnabled(process.env, readStoredEnabled(app.getPath('userData')))) {
    await startServer();
  }
}

export function isAutomationRunning(): boolean {
  return server !== null;
}
