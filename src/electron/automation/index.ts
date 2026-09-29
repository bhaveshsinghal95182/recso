/**
 * The Automation API's lifecycle inside recso's main process.
 *
 * Nothing here runs unless the API is turned on: no socket, no pipe, no
 * listener, no settings store. `initializeAutomation` is the only entry point
 * main.ts calls.
 */

import os from 'node:os';

import { app, type BrowserWindow, ipcMain } from 'electron';

import { registerAllMethods } from './methods/all.js';
import { EVENT_NAMES } from './methods/events.js';
import { setActiveSettings } from './active-settings.js';
import { createElectronServices } from './electron-services.js';
import {
  automationEnabled,
  automationOverride,
  readStoredEnabled,
  writeStoredEnabled,
} from './enabled.js';
import { connectEvents } from './event-bridge.js';
import { cachedHooksLoader, HookRunner, spawnHook } from './hooks.js';
import { PendingNavigation } from './navigation.js';
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
let disconnect: (() => void) | null = null;
let services: AutomationServices | null = null;
let hooks: HookRunner | null = null;
let lastStartError: string | null = null;
/** Serialises the toggle: a quick off-on must not start a second server over the first. */
let toggling: Promise<unknown> = Promise.resolve();
const navigation = new PendingNavigation(() => sendToWindow('automation:navigate'));

function currentTransport() {
  return transportPath(process.platform, {
    env: process.env,
    username: os.userInfo().username,
    tmpdir: os.tmpdir(),
  });
}

function sendToWindow(channel: string, ...args: unknown[]): void {
  const window = mainWindowRef;
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(channel, ...args);
  }
}

/** What Settings shows: whether the API is on, where, and whether anything is connected. */
export interface AutomationState {
  running: boolean;
  path: string;
  connections: number;
  /** Why the last start failed (another recso already serving, say). */
  error: string | null;
  /** What RECSO_AUTOMATION forced at launch, if anything. */
  override: 'on' | 'off' | null;
}

function automationState(): AutomationState {
  return {
    running: server !== null,
    path: currentTransport().path,
    connections: server?.connectionCount ?? 0,
    error: lastStartError,
    override: automationOverride(process.env),
  };
}

function pushState(): void {
  sendToWindow('automation:state', automationState());
}

/** Every API event goes to subscribed connections and to the hooks in automation.json. */
function dispatch(event: string, payload: unknown): void {
  server?.broadcast(event, payload);
  hooks?.run(event, payload);
}

async function startServer(): Promise<void> {
  if (server) return;
  const transport = currentTransport();
  const store = new SettingsStore(defaultSettings(app.getPath('videos')));
  const candidateServices = createElectronServices({
    getWindow: () => mainWindowRef,
    transportPath: transport.path,
    settings: store,
    navigation,
    emit: (event, payload) => dispatch(event, payload),
  });
  const candidate = new AutomationServer({
    registry: registerAllMethods(new MethodRegistry(), candidateServices),
    transport,
    log: (message) => console.log(message),
    onConnectionCountChange: () => pushState(),
  });
  try {
    await candidate.start();
  } catch (error) {
    // Never fatal: recso works the same without its API.
    lastStartError = error instanceof Error ? error.message : String(error);
    console.error('[Automation] Could not start:', lastStartError);
    pushState();
    return;
  }
  lastStartError = null;
  server = candidate;
  services = candidateServices;
  settings = store;
  setActiveSettings(store);
  hooks = new HookRunner({
    platform: process.platform,
    loadHooks: cachedHooksLoader(app.getPath('userData'), EVENT_NAMES, (errors) =>
      console.warn(`[Automation] automation.json: ${errors.join('; ')}`),
    ),
    spawn: spawnHook,
    log: (message) => console.warn(`[Automation] ${message}`),
  });
  const offRenderer = store.onChange(() =>
    sendToWindow('automation:recorder-settings', { active: true, values: store.get() }),
  );
  const offEvents = connectEvents(dispatch, store);
  disconnect = () => {
    offRenderer();
    offEvents();
  };
  sendToWindow('automation:recorder-settings', { active: true, values: store.get() });
  pushState();
}

async function stopServer(): Promise<void> {
  const running = server;
  server = null;
  // An export process outliving recso would write a file nobody asked about.
  services?.exports.cancelAll();
  services = null;
  hooks?.stopAll();
  hooks = null;
  settings = null;
  setActiveSettings(null);
  disconnect?.();
  disconnect = null;
  await running?.stop();
  sendToWindow('automation:recorder-settings', { active: false });
  pushState();
}

/**
 * The renderer's side of the settings: the recorder UI adopts the API's
 * values and writes its own changes back, but only while the API is on.
 */
function registerRendererBridge(): void {
  ipcMain.handle('automation:take-navigation', () => navigation.take());
  ipcMain.handle('automation:get-state', () => automationState());
  // Settings ▸ Advanced ▸ Automation API: stored for next launch, and applied now.
  ipcMain.handle('automation:set-enabled', (_event, enabled: unknown) => {
    const on = enabled === true;
    const next = toggling.then(async () => {
      writeStoredEnabled(app.getPath('userData'), on);
      if (on) {
        lastStartError = null;
        await startServer();
      } else {
        lastStartError = null;
        await stopServer();
      }
      return automationState();
    });
    toggling = next.catch(() => undefined);
    return next;
  });
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
