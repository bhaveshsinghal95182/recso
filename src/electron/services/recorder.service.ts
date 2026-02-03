/**
 * RecorderService — quick overview:
 * - Enumerates sources.
 * - Manages a single streaming `.webm` recording lifecycle (start, append, pause, resume, stop) and moves final files to the chosen output.
 * - Integrates with DB for metadata and provides a temp-path recovery helper.
 */

import { app, desktopCapturer } from 'electron';

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

/** Active recording session state */
interface ActiveRecording {
  id: string;
  tempPath: string;
  outputDir: string;
  fileName: string;
  fileExtension: 'mp4' | 'webm';
  writeStream: fs.WriteStream;
  state: RecordingState;
  startedAt: number;
  bytesWritten: number;
}

// Current active recording (only one at a time)
let activeRecording: ActiveRecording | null = null;

/**
 * Get available desktop sources (screens and windows)
 */
export async function getSources(): Promise<DesktopSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnailDataUrl: source.thumbnail.toDataURL(),
    isScreen: source.id.startsWith('screen:'),
  }));
}

/**
 * Start a new recording session
 * Creates temp file and database entry
 */
export function startRecording(config: RecordingConfig): StartRecordingResult {
  if (activeRecording) {
    return { success: false, error: 'A recording is already in progress' };
  }

  try {
    const recordingId = randomUUID();
    const fileExt = config.fileExtension || 'webm';
    const tempDir = path.join(app.getPath('temp'), 'recso');
    const tempPath = path.join(tempDir, `rec_${recordingId}.${fileExt}`);

    // Ensure temp directory exists
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Create write stream for streaming writes
    const writeStream = fs.createWriteStream(tempPath, { flags: 'a' });

    // Store in database
    createRecording({
      id: recordingId,
      status: 'recording',
      tempPath,
      finalPath: null,
      outputDir: config.outputDir,
      fileName: config.fileName,
      sourceId: config.sourceId,
      startedAt: Date.now(),
      windowBounds: null, // Will be updated from renderer
    });

    // Set active recording
    activeRecording = {
      id: recordingId,
      tempPath,
      outputDir: config.outputDir,
      fileName: config.fileName,
      fileExtension: fileExt,
      writeStream,
      state: 'RECORDING' as RecordingState,
      startedAt: Date.now(),
      bytesWritten: 0,
    };

    console.log('[RecorderService] Started recording:', recordingId);

    return {
      success: true,
      recordingId,
      tempPath,
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
 * Append a video chunk to the active recording
 * Called repeatedly from renderer as MediaRecorder produces data
 */
export function appendChunk(recordingId: string, chunk: Buffer): boolean {
  if (!activeRecording || activeRecording.id !== recordingId) {
    console.warn('[RecorderService] No active recording for ID:', recordingId);
    return false;
  }

  if (activeRecording.state === 'PAUSED') {
    // Don't write while paused
    return true;
  }

  try {
    activeRecording.writeStream.write(chunk);

    const oldBytes = activeRecording.bytesWritten;
    activeRecording.bytesWritten += chunk.length;

    // Log first chunk and every ~5MB
    if (oldBytes === 0) {
      console.log('[RecorderService] First chunk written. Size:', chunk.length);
    } else if (
      Math.floor(activeRecording.bytesWritten / (5 * 1024 * 1024)) >
      Math.floor(oldBytes / (5 * 1024 * 1024))
    ) {
      console.log(
        `[RecorderService] Written ${(activeRecording.bytesWritten / 1024 / 1024).toFixed(2)} MB...`,
      );
    }

    return true;
  } catch (error) {
    console.error('[RecorderService] Failed to write chunk:', error);
    return false;
  }
}

/**
 * Stop the active recording and finalize the file
 */
export async function stopRecording(recordingId: string): Promise<StopRecordingResult> {
  if (!activeRecording || activeRecording.id !== recordingId) {
    return { success: false, error: 'No active recording with this ID' };
  }

  try {
    // Close the write stream
    await new Promise<void>((resolve, reject) => {
      activeRecording!.writeStream.end((err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Check final file size
    const stats = fs.statSync(activeRecording.tempPath);
    if (stats.size === 0) {
      console.error('[RecorderService] WARNING: Recording resulted in 0-byte file!');
    } else {
      console.log('[RecorderService] Recording finished. Size:', stats.size);
    }

    // Ensure root output directory exists
    if (!fs.existsSync(activeRecording.outputDir)) {
      fs.mkdirSync(activeRecording.outputDir, { recursive: true });
    }

    // Determine recording folder name (handling duplicates)
    // We want a dedicated folder for each recording: outputDir/RecordingName/
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

    // Initialize project structure (.recso, exports) inside the recording folder
    initProjectFolder(recordingFolderPath);

    // Determine final video path inside the recording folder
    // Format: outputDir/RecordingName/RecordingName.{ext}
    const ext = `.${activeRecording.fileExtension}`;
    const finalPath = path.join(recordingFolderPath, `${folderName}${ext}`);

    // Move temp file to final location
    fs.renameSync(activeRecording.tempPath, finalPath);

    // Update database
    completeRecording(recordingId, finalPath);

    console.log('[RecorderService] Recording saved to:', finalPath);

    // Clear active recording
    activeRecording = null;

    return { success: true, filePath: finalPath };
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
 * Get current recording state
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

  return {
    state: activeRecording.state,
    recordingId: activeRecording.id,
    duration,
    bytesWritten: activeRecording.bytesWritten,
  };
}

/**
 * Get the temp path for a recording (for crash recovery)
 */
export function getTempPath(recordingId: string): string | null {
  const recording = getRecording(recordingId);
  return recording?.tempPath || null;
}
