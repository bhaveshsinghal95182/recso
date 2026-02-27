import { type BrowserWindow, ipcMain, screen } from 'electron';

import { mouseTrackerService } from '../../services/mouse-tracker.service.js';
import * as VelocityRecorderService from '../../services/recorder/velocity-recorder.service.js';
import * as velocityDb from '../../services/velocity-database.service.js';
import type { RecordingConfig } from '../../types/recorder.types.js';

let mainWindowRef: BrowserWindow | null = null;

export function setVelocityRecorderMainWindow(window: BrowserWindow): void {
  mainWindowRef = window;
}

/**
 * Get monitor bounds for the primary display in PHYSICAL pixels.
 *
 * IMPORTANT: Electron's screen.getPrimaryDisplay().bounds returns LOGICAL (DIP)
 * coordinates, but uiohook-napi reports PHYSICAL pixel coordinates.
 * We must multiply by scaleFactor to match uiohook's coordinate space.
 */
function getPrimaryDisplayInfo() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const sf = primaryDisplay.scaleFactor;

  const bounds = {
    x: primaryDisplay.bounds.x * sf,
    y: primaryDisplay.bounds.y * sf,
    width: primaryDisplay.bounds.width * sf,
    height: primaryDisplay.bounds.height * sf,
  };

  console.log('[VelocityRecorderIPC] Display info:', {
    logicalBounds: primaryDisplay.bounds,
    scaleFactor: sf,
    physicalBounds: bounds,
  });

  return { bounds, scaleFactor: sf };
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
        const { bounds, scaleFactor } = getPrimaryDisplayInfo();

        // Start tracking with bounds → enables Velocity mode (60fps, velocity.db)
        mouseTrackerService.startTracking(result.recordingId, bounds);

        // Save capture metadata for later reference
        velocityDb.saveMetadata({
          recordingId: result.recordingId,
          monitorWidth: bounds.width,
          monitorHeight: bounds.height,
          scaleFactor,
          captureFps: 60,
          captureSource: 'monitor',
        });

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
        const { bounds, scaleFactor } = getPrimaryDisplayInfo();

        // Start tracking with bounds → enables Velocity mode (60fps, velocity.db)
        mouseTrackerService.startTracking(result.recordingId, bounds);

        // Save capture metadata for later reference
        velocityDb.saveMetadata({
          recordingId: result.recordingId,
          monitorWidth: bounds.width,
          monitorHeight: bounds.height,
          scaleFactor,
          captureFps: 60,
          captureSource: 'window',
          windowTitle,
        });

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

  ipcMain.handle('velocity:get-mouse-events', async (_event, recordingId: string) => {
    return mouseTrackerService.getEventsForRecording(recordingId);
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
