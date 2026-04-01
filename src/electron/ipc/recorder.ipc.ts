/**
 * IPC handlers for recording functionality
 */

import { app, type BrowserWindow, dialog, ipcMain } from 'electron';

import fs from 'fs';
import path from 'path';

import { mouseTrackerService } from '../services/mouse-tracker.service.js';
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

    if (result.success && result.recordingId) {
      // Start mouse tracking for this recording
      mouseTrackerService.startTracking(result.recordingId);
      console.log('[RecorderIPC] Mouse tracking started for recording:', result.recordingId);

      // Start pushing state updates
      startStatePolling();
    }

    return result;
  });

  // Append a video chunk (legacy sequential append)
  ipcMain.handle(
    'recorder:append-chunk',
    async (_event, recordingId: string, chunk: ArrayBuffer) => {
      const buffer = Buffer.from(chunk);
      return RecorderService.appendChunk(recordingId, buffer);
    },
  );

  // Write a chunk at a specific byte offset to a specific stream (mediabunny StreamTarget)
  ipcMain.handle(
    'recorder:write-chunk',
    async (_event, recordingId: string, streamId: string, position: number, chunk: ArrayBuffer) => {
      const buffer = Buffer.from(chunk);
      return RecorderService.writeChunk(recordingId, streamId, position, buffer);
    },
  );

  // Stop recording
  ipcMain.handle('recorder:stop', async (_event, recordingId: string) => {
    stopStatePolling();

    // Stop mouse tracking
    const clickCount = mouseTrackerService.stopTracking();
    console.log('[RecorderIPC] Mouse tracking stopped. Total clicks:', clickCount);

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

  // Settings handlers
  ipcMain.handle('recorder:show-save-dialog', async (_event, defaultName: string) => {
    const result = await dialog.showSaveDialog({
      title: 'Save Recording',
      defaultPath: path.join(app.getPath('videos'), defaultName),
      filters: [
        { name: 'MP4 Video', extensions: ['mp4'] },
        { name: 'MKV Video', extensions: ['mkv'] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    return result.filePath;
  });

  ipcMain.handle('recorder:show-open-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindowRef!, {
      title: 'Select Output Folder',
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle('recorder:get-default-output-dir', async () => {
    return app.getPath('videos');
  });

  ipcMain.handle(
    'recorder:validate-output-path',
    async (_event, outputPath: string): Promise<{ valid: boolean; error?: string }> => {
      try {
        // Check if path exists
        if (!fs.existsSync(outputPath)) {
          // Try to create it
          fs.mkdirSync(outputPath, { recursive: true });
        }

        // Check write permissions by attempting to write a temp file
        const testFile = path.join(outputPath, `.recso_write_test_${Date.now()}`);
        fs.writeFileSync(testFile, '');
        fs.unlinkSync(testFile);

        return { valid: true };
      } catch (error) {
        return {
          valid: false,
          error: error instanceof Error ? error.message : 'Cannot write to directory',
        };
      }
    },
  );

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
