/**
 * IPC handlers for recording functionality
 */

import { app, type BrowserWindow, dialog, ipcMain } from 'electron';

import fs from 'fs';
import path from 'path';

import { mouseTrackerService } from '../services/mouse-tracker.service.js';
import * as RecorderService from '../services/recorder.service.js';
import { recorderEvents } from '../services/recorder-events.js';
import * as RecoveryService from '../services/recovery.service.js';
import type {
  RecordingConfig,
  StartRecordingResult,
  StopRecordingResult,
} from '../types/recorder.types.js';

// Reference to main window for pushing state updates
let mainWindowRef: BrowserWindow | null = null;

/**
 * Set the main window reference for state push
 */
export function setRecorderMainWindow(window: BrowserWindow): void {
  mainWindowRef = window;

  window.once('closed', () => {
    if (mainWindowRef === window) {
      mainWindowRef = null;
      stopStatePolling(false);
      RecorderService.stopNativeWebcamPreview();
    }
  });

  window.webContents.on('render-process-gone', () => {
    if (mainWindowRef === window) {
      stopStatePolling(false);
      RecorderService.stopNativeWebcamPreview();
    }
  });

  window.webContents.once('destroyed', () => {
    if (mainWindowRef === window) {
      stopStatePolling(false);
      RecorderService.stopNativeWebcamPreview();
    }
  });
}

/**
 * Register all recorder IPC handlers
 */
export function registerRecorderHandlers(): void {
  // Get available sources (screens/windows)
  // Microphones as WASAPI sees them. The browser's own list cannot be used for
  // native capture: its ids are salted per origin and resolve to nothing here.
  ipcMain.handle('recorder:list-audio-capture-devices', () =>
    RecorderService.listNativeAudioCaptureDevices(),
  );

  // Webcams as Media Foundation sees them. These ids are the only ids the
  // native recorder accepts; renderer-originated device ids are deliberately
  // not part of this interface.
  ipcMain.handle('recorder:list-webcam-devices', () => RecorderService.listNativeWebcamDevices());

  ipcMain.handle('recorder:start-webcam-preview', (_event, deviceId?: string) =>
    RecorderService.startNativeWebcamPreview(deviceId),
  );
  ipcMain.handle('recorder:stop-webcam-preview', () => RecorderService.stopNativeWebcamPreview());
  ipcMain.handle('recorder:webcam-preview-frame', () => {
    const frame = RecorderService.nativeWebcamPreviewFrame();
    if (!frame) {
      return null;
    }

    return {
      jpeg: frame.jpeg.buffer.slice(
        frame.jpeg.byteOffset,
        frame.jpeg.byteOffset + frame.jpeg.byteLength,
      ),
      width: frame.width,
      height: frame.height,
      sequence: frame.sequence,
    };
  });

  ipcMain.handle('recorder:get-sources', async () => {
    return RecorderService.getSources();
  });

  // Start a new recording
  ipcMain.handle('recorder:start', async (_event, config: RecordingConfig) =>
    startRecordingSession(config),
  );

  ipcMain.handle(
    'recorder:stop',
    async (_event, recordingId: string) => (await stopRecordingSession(recordingId)).result,
  );

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

/**
 * Start a recording: the capture, mouse tracking and the state pushes that
 * drive the recorder's timer.
 *
 * The recorder's button and the Automation API both start recordings here, so
 * one started either way looks the same in the UI and stops the same way.
 */
export function startRecordingSession(config: RecordingConfig): StartRecordingResult {
  const result = RecorderService.startRecording(config);

  if (result.success && result.recordingId) {
    const trackingBounds = RecorderService.resolveMouseTrackingBounds(config.sourceId);

    // Start mouse tracking for this recording
    mouseTrackerService.startTracking(result.recordingId, trackingBounds);
    console.log('[RecorderIPC] Mouse tracking started for recording:', result.recordingId);
    if (trackingBounds) {
      console.log('[RecorderIPC] Mouse tracking bounds:', trackingBounds);
    }

    // Start pushing state updates, with one straight away so a recorder
    // screen that is already showing picks the recording up at once.
    startStatePolling();
    pushState();
    recorderEvents.emit('started', { recordingId: result.recordingId, config });
  }

  return result;
}

/**
 * Stop a recording and wait for its file to be finalised, reporting the clicks
 * tracked during it. See `startRecordingSession`.
 */
export async function stopRecordingSession(
  recordingId: string,
): Promise<{ result: StopRecordingResult; clicks: number }> {
  stopStatePolling();
  recorderEvents.emit('stopping', { recordingId });

  // Stop mouse tracking
  const clickCount = mouseTrackerService.stopTracking();
  console.log('[RecorderIPC] Mouse tracking stopped. Total clicks:', clickCount);

  const result = await RecorderService.stopRecording(recordingId);
  // The final push above ran before the finalize; this one reports idle.
  pushState();
  recorderEvents.emit('stopped', { recordingId, result, clicks: clickCount });
  return { result, clicks: clickCount };
}

// State polling for real-time updates
let statePollingInterval: NodeJS.Timeout | null = null;

function startStatePolling(): void {
  if (statePollingInterval) return;

  statePollingInterval = setInterval(() => {
    pushState();
  }, 500);
}

function stopStatePolling(pushFinalState: boolean = true): void {
  if (statePollingInterval) {
    clearInterval(statePollingInterval);
    statePollingInterval = null;
  }

  if (pushFinalState) {
    pushState();
  }
}

function pushState(): void {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    stopStatePolling(false);
    return;
  }

  const webContents = mainWindowRef.webContents;
  if (webContents.isDestroyed() || webContents.isCrashed()) {
    stopStatePolling(false);
    return;
  }

  try {
    const state = RecorderService.getState();
    webContents.send('recorder:state', state);
  } catch (error) {
    console.warn('[RecorderIPC] Failed to push recorder state:', error);
    stopStatePolling(false);
  }
}
