/**
 * RecorderService — quick overview:
 * - Enumerates sources.
 * - Manages a single streaming recording lifecycle (start, writeChunk, pause, resume, stop) and moves final files to the chosen output.
 * - Supports multiple parallel streams (screen, camera) each with their own file descriptor.
 * - Uses raw file descriptors for random-access writes (required by mediabunny's StreamTarget).
 * - Integrates with DB for metadata and provides a temp-path recovery helper.
 */

import { app, desktopCapturer, screen } from 'electron';

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import type {
  DesktopSource,
  RecordingConfig,
  RecordingState,
  RecordingStateEvent,
  StartRecordingResult,
  StopRecordingResult,
} from '../types/recorder.types.js';
import {
  completeRecording,
  createRecording,
  getRecording,
  updateRecordingStatus,
} from './database.service.js';
import { initProjectFolder } from './project-storage.service.js';

/** State for a single file stream (screen or camera) */
interface StreamState {
  tempPath: string;
  /** Raw file descriptor for random-access writes */
  fd: number;
  bytesWritten: number;
}

/** Active recording session state — supports multiple parallel streams */
interface ActiveRecording {
  id: string;
  /** Map of streamId ('screen' | 'camera') to its file state */
  streams: Record<string, StreamState>;
  outputDir: string;
  fileName: string;
  fileExtension: 'mp4' | 'mkv';
  state: RecordingState;
  startedAt: number;
}

// Current active recording (only one at a time)
let activeRecording: ActiveRecording | null = null;

/**
 * Get available desktop sources (screens and windows)
 */
export async function getSources(): Promise<DesktopSource[]> {
  const isPackagedWindows = process.platform === 'win32' && app.isPackaged;
  const attemptCount = isPackagedWindows ? 3 : 1;
  const displayById = new Map(
    screen.getAllDisplays().map((display) => [String(display.id), display]),
  );
  const sourceById = new Map<string, DesktopSource>();

  for (let attempt = 1; attempt <= attemptCount; attempt++) {
    const batch = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });

    for (const source of batch) {
      const isScreen = source.id.startsWith('screen:');
      const displayId = source.display_id ? String(source.display_id) : null;
      const matchedDisplay = displayId ? displayById.get(displayId) : undefined;

      sourceById.set(source.id, {
        id: source.id,
        name: source.name,
        thumbnailDataUrl: source.thumbnail.toDataURL(),
        isScreen,
        width: matchedDisplay?.size.width,
        height: matchedDisplay?.size.height,
        isPrimary: matchedDisplay ? matchedDisplay.id === screen.getPrimaryDisplay().id : undefined,
      });
    }

    if (isPackagedWindows) {
      const screens = Array.from(sourceById.values()).filter((s) => s.isScreen).length;
      const windows = sourceById.size - screens;
      console.log(
        `[RecorderService] getSources attempt ${attempt}/${attemptCount}: total=${sourceById.size}, screens=${screens}, windows=${windows}`,
      );

      // Sometimes AppX builds return incomplete snapshots on first call.
      if (attempt < attemptCount) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  return Array.from(sourceById.values());
}

/**
 * Open a stream file descriptor and return its StreamState.
 */
function openStreamFd(
  tempDir: string,
  recordingId: string,
  streamId: string,
  ext: string,
): StreamState {
  const tempPath = path.join(tempDir, `rec_${recordingId}_${streamId}.${ext}`);
  const fd = fs.openSync(tempPath, 'w');
  return { tempPath, fd, bytesWritten: 0 };
}

/**
 * Start a new recording session.
 * Creates temp files and database entry. If config.recordCamera is true,
 * a second temp file is opened for the camera stream.
 */
export function startRecording(config: RecordingConfig): StartRecordingResult {
  if (activeRecording) {
    return { success: false, error: 'A recording is already in progress' };
  }

  try {
    const recordingId = randomUUID();
    const fileExt = config.fileExtension || 'mp4';
    const tempDir = path.join(app.getPath('temp'), 'recso');

    // Ensure temp directory exists
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Open file descriptors for each enabled stream
    const streams: Record<string, StreamState> = {};
    streams['screen'] = openStreamFd(tempDir, recordingId, 'screen', fileExt);

    if (config.recordCamera) {
      streams['camera'] = openStreamFd(tempDir, recordingId, 'camera', fileExt);
    }

    // Store in database (use the screen temp path as the primary)
    createRecording({
      id: recordingId,
      status: 'recording',
      tempPath: streams['screen'].tempPath,
      finalPath: null,
      outputDir: config.outputDir,
      fileName: config.fileName,
      sourceId: config.sourceId,
      startedAt: Date.now(),
      windowBounds: null,
    });

    // Set active recording
    activeRecording = {
      id: recordingId,
      streams,
      outputDir: config.outputDir,
      fileName: config.fileName,
      fileExtension: fileExt,
      state: 'RECORDING' as RecordingState,
      startedAt: Date.now(),
    };

    const streamIds = Object.keys(streams);
    console.log(
      `[RecorderService] Started recording: ${recordingId} (streams: ${streamIds.join(', ')})`,
    );

    return {
      success: true,
      recordingId,
      tempPath: streams['screen'].tempPath,
    };
  } catch (error) {
    console.error('[RecorderService] Failed to start recording:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Write a chunk at a specific byte offset (random-access) to a given stream.
 * Called repeatedly from renderer as mediabunny's StreamTarget produces data.
 *
 * @param streamId - Which stream to write to ('screen' | 'camera')
 */
export function writeChunk(
  recordingId: string,
  streamId: string,
  position: number,
  chunk: Buffer,
): boolean {
  if (!activeRecording || activeRecording.id !== recordingId) {
    console.warn('[RecorderService] No active recording for ID:', recordingId);
    return false;
  }

  const stream = activeRecording.streams[streamId];
  if (!stream) {
    console.warn(`[RecorderService] Unknown streamId "${streamId}" for recording:`, recordingId);
    return false;
  }

  try {
    fs.writeSync(stream.fd, chunk, 0, chunk.length, position);

    const newEnd = position + chunk.length;
    if (newEnd > stream.bytesWritten) {
      stream.bytesWritten = newEnd;
    }

    return true;
  } catch (error) {
    console.error(`[RecorderService] Failed to write chunk to stream "${streamId}":`, error);
    return false;
  }
}

/**
 * Append a video chunk to the active recording (legacy sequential append).
 * Kept for backward compatibility / recovery scenarios.
 * Always writes to the 'screen' stream.
 */
export function appendChunk(recordingId: string, chunk: Buffer): boolean {
  if (!activeRecording || activeRecording.id !== recordingId) {
    console.warn('[RecorderService] No active recording for ID:', recordingId);
    return false;
  }

  if (activeRecording.state === 'PAUSED') {
    return true;
  }

  const stream = activeRecording.streams['screen'];
  if (!stream) {
    console.warn('[RecorderService] No screen stream for legacy append');
    return false;
  }

  try {
    fs.writeSync(stream.fd, chunk, 0, chunk.length, stream.bytesWritten);

    const oldBytes = stream.bytesWritten;
    stream.bytesWritten += chunk.length;

    if (oldBytes === 0) {
      console.log('[RecorderService] First chunk written. Size:', chunk.length);
    } else if (
      Math.floor(stream.bytesWritten / (5 * 1024 * 1024)) > Math.floor(oldBytes / (5 * 1024 * 1024))
    ) {
      console.log(
        `[RecorderService] Written ${(stream.bytesWritten / 1024 / 1024).toFixed(2)} MB...`,
      );
    }

    return true;
  } catch (error) {
    console.error('[RecorderService] Failed to write chunk:', error);
    return false;
  }
}

/**
 * Stop the active recording and finalize all stream files.
 * Moves all temp files to the final project folder.
 */
export async function stopRecording(recordingId: string): Promise<StopRecordingResult> {
  if (!activeRecording || activeRecording.id !== recordingId) {
    return { success: false, error: 'No active recording with this ID' };
  }

  try {
    // Close all file descriptors
    for (const [streamId, stream] of Object.entries(activeRecording.streams)) {
      fs.closeSync(stream.fd);
      const stats = fs.statSync(stream.tempPath);
      if (stats.size === 0) {
        console.error(`[RecorderService] WARNING: Stream "${streamId}" resulted in 0-byte file!`);
      } else {
        console.log(`[RecorderService] Stream "${streamId}" finished. Size: ${stats.size}`);
      }
    }

    // Ensure root output directory exists
    if (!fs.existsSync(activeRecording.outputDir)) {
      fs.mkdirSync(activeRecording.outputDir, { recursive: true });
    }

    // Determine recording folder name (handling duplicates)
    let folderName = activeRecording.fileName;
    let recordingFolderPath = path.join(activeRecording.outputDir, folderName);
    let counter = 1;

    while (fs.existsSync(recordingFolderPath)) {
      folderName = `${activeRecording.fileName}_${counter}`;
      recordingFolderPath = path.join(activeRecording.outputDir, folderName);
      counter++;
    }

    // Create the dedicated recording folder
    fs.mkdirSync(recordingFolderPath, { recursive: true });

    // Initialize project structure (.recso, exports)
    initProjectFolder(recordingFolderPath);

    const ext = `.${activeRecording.fileExtension}`;

    // Move each stream's temp file to its final location
    // Screen: RecordingName.mp4
    // Camera: RecordingName_camera.mp4
    let screenFinalPath = '';
    for (const [streamId, stream] of Object.entries(activeRecording.streams)) {
      const suffix = streamId === 'screen' ? '' : `_${streamId}`;
      const finalPath = path.join(recordingFolderPath, `${folderName}${suffix}${ext}`);

      fs.renameSync(stream.tempPath, finalPath);
      console.log(`[RecorderService] Stream "${streamId}" saved to: ${finalPath}`);

      if (streamId === 'screen') {
        screenFinalPath = finalPath;
      }
    }

    // Update database with the primary (screen) file path
    completeRecording(recordingId, screenFinalPath);

    console.log('[RecorderService] Recording saved to:', screenFinalPath);

    // Clear active recording
    activeRecording = null;

    return { success: true, filePath: screenFinalPath };
  } catch (error) {
    console.error('[RecorderService] Failed to stop recording:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Pause the active recording
 */
export function pauseRecording(recordingId: string): boolean {
  if (!activeRecording || activeRecording.id !== recordingId) {
    return false;
  }

  activeRecording.state = 'PAUSED' as RecordingState;
  updateRecordingStatus(recordingId, 'paused');
  console.log('[RecorderService] Recording paused:', recordingId);
  return true;
}

/**
 * Resume a paused recording
 */
export function resumeRecording(recordingId: string): boolean {
  if (!activeRecording || activeRecording.id !== recordingId) {
    return false;
  }

  activeRecording.state = 'RECORDING' as RecordingState;
  updateRecordingStatus(recordingId, 'recording');
  console.log('[RecorderService] Recording resumed:', recordingId);
  return true;
}

/**
 * Get current recording state.
 * Returns aggregate bytesWritten across all streams.
 */
export function getState(): RecordingStateEvent {
  if (!activeRecording) {
    return {
      state: 'IDLE' as RecordingState,
      recordingId: null,
      duration: 0,
      bytesWritten: 0,
    };
  }

  const duration = Date.now() - activeRecording.startedAt;

  // Sum bytes across all streams
  let totalBytesWritten = 0;
  for (const stream of Object.values(activeRecording.streams)) {
    totalBytesWritten += stream.bytesWritten;
  }

  return {
    state: activeRecording.state,
    recordingId: activeRecording.id,
    duration,
    bytesWritten: totalBytesWritten,
  };
}

/**
 * Get the temp path for a recording (for crash recovery)
 */
export function getTempPath(recordingId: string): string | null {
  const recording = getRecording(recordingId);
  return recording?.tempPath || null;
}
