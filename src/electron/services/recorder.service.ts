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

/** Active recording session state */
interface ActiveRecording {
  id: string;
  tempPath: string;
  outputDir: string;
  fileName: string;
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
    const tempDir = path.join(app.getPath('temp'), 'recso');
    const tempPath = path.join(tempDir, `rec_${recordingId}.webm`);

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
    activeRecording.bytesWritten += chunk.length;
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

    // Determine final path
    const ext = '.webm';
    let finalPath = path.join(activeRecording.outputDir, `${activeRecording.fileName}${ext}`);

    // Handle duplicate file names
    let counter = 1;
    while (fs.existsSync(finalPath)) {
      finalPath = path.join(
        activeRecording.outputDir,
        `${activeRecording.fileName}_${counter}${ext}`,
      );
      counter++;
    }

    // Ensure output directory exists
    if (!fs.existsSync(activeRecording.outputDir)) {
      fs.mkdirSync(activeRecording.outputDir, { recursive: true });
    }

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
