/**
 * IPC handlers for recording functionality
 */

import { type BrowserWindow, ipcMain } from 'electron';

import * as RecorderService from '../services/recorder.service.js';
import * as RecoveryService from '../services/recovery.service.js';
import type { RecordingConfig } from '../types/recorder.types.js';

// Reference to main window for pushing state updates
let mainWindowRef: BrowserWindow | null = null;

/**
 * Set the main window reference for state push
 */
export function setRecorderMainWindow(window: BrowserWindow): void {
  mainWindowRef = window;
}

/**
 * Register all recorder IPC handlers
 */
export function registerRecorderHandlers(): void {
  // Get available sources (screens/windows)
  ipcMain.handle('recorder:get-sources', async () => {
    return RecorderService.getSources();
  });

  // Start a new recording
  ipcMain.handle('recorder:start', async (_event, config: RecordingConfig) => {
    const result = RecorderService.startRecording(config);

    if (result.success) {
      // Start pushing state updates
      startStatePolling();
    }

    return result;
  });

  // Append a video chunk
  ipcMain.handle(
    'recorder:append-chunk',
    async (_event, recordingId: string, chunk: ArrayBuffer) => {
      const buffer = Buffer.from(chunk);
      return RecorderService.appendChunk(recordingId, buffer);
    },
  );

  // Stop recording
  ipcMain.handle('recorder:stop', async (_event, recordingId: string) => {
    stopStatePolling();
    return RecorderService.stopRecording(recordingId);
  });

  // Pause recording
  ipcMain.on('recorder:pause', (_event, recordingId: string) => {
    RecorderService.pauseRecording(recordingId);
    pushState();
  });

  // Resume recording
  ipcMain.on('recorder:resume', (_event, recordingId: string) => {
    RecorderService.resumeRecording(recordingId);
    pushState();
  });

  // Get current state
  ipcMain.handle('recorder:get-state', async () => {
    return RecorderService.getState();
  });

  // Recovery handlers
  ipcMain.handle('recorder:get-orphans', async () => {
    return RecoveryService.getOrphanDetails();
  });

  ipcMain.handle('recorder:recover', async (_event, id: string, outputPath: string) => {
    return RecoveryService.recoverRecording(id, outputPath);
  });

  ipcMain.handle('recorder:delete-orphan', async (_event, id: string) => {
    return RecoveryService.deleteOrphanedRecording(id);
  });

  console.log('[RecorderIPC] Handlers registered');
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
    const state = RecorderService.getState();
    mainWindowRef.webContents.send('recorder:state', state);
  }
}
