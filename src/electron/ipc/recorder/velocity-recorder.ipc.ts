import { type BrowserWindow, ipcMain } from 'electron';

import { mouseTrackerService } from '../../services/mouse-tracker.service.js';
import * as VelocityRecorderService from '../../services/recorder/velocity-recorder.service.js';
import type { RecordingConfig } from '../../types/recorder.types.js';

let mainWindowRef: BrowserWindow | null = null;

export function setVelocityRecorderMainWindow(window: BrowserWindow): void {
  mainWindowRef = window;
}

export function registerVelocityRecorderHandlers(): void {
  ipcMain.handle('velocity:is-cursor-settings-supported', async () => {
    return VelocityRecorderService.checkCursorSettingsSupported();
  });

  ipcMain.handle('velocity:list-available-windows', async () => {
    return VelocityRecorderService.getAvailableWindows();
  });

  ipcMain.handle(
    'velocity:start-monitor-recording',
    async (_event, config: RecordingConfig, bitrate: number) => {
      const result = VelocityRecorderService.recordMonitor(config, bitrate);
      if (result.success && result.recordingId) {
        mouseTrackerService.startTracking(result.recordingId);
        startStatePolling();
      }
      return result;
    },
  );

  ipcMain.handle(
    'velocity:start-window-recording',
    async (_event, windowTitle: string, config: RecordingConfig, bitrate: number) => {
      const result = VelocityRecorderService.recordWindow(windowTitle, config, bitrate);
      if (result.success && result.recordingId) {
        mouseTrackerService.startTracking(result.recordingId);
        startStatePolling();
      }
      return result;
    },
  );

  ipcMain.handle('velocity:stop-recording', async (_event, recordingId: string) => {
    stopStatePolling();
    const clickCount = mouseTrackerService.stopTracking();
    console.log('[VelocityRecorderIPC] Mouse tracking stopped. Total clicks:', clickCount);
    return VelocityRecorderService.stopRecording(recordingId);
  });
}

// State polling for real-time updates
let statePollingInterval: NodeJS.Timeout | null = null;

function startStatePolling(): void {
  if (statePollingInterval) return;

  statePollingInterval = setInterval(() => {
    pushState();
  }, 500);
}

function stopStatePolling(): void {
  if (statePollingInterval) {
    clearInterval(statePollingInterval);
    statePollingInterval = null;
  }
  pushState(); // Final state update
}

function pushState(): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    const state = VelocityRecorderService.getState();
    mainWindowRef.webContents.send('recorder:state', state);
  }
}
