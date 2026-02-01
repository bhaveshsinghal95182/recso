/**
 * RecorderService — quick overview:
 * - Enumerates sources via native Rust addon (cursor-free capable).
 * - Manages recording lifecycle via native recorder (start, pause, resume, stop).
 * - Integrates with DB for metadata and mouse tracking.
 *
 * NOTE: Video encoding and file writing is handled entirely in Rust.
 * No video chunks are sent from the renderer to the main process.
 */

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
import { mouseTrackerService } from './mouse-tracker.service.js';
import { nativeRecorderService, type NativeRecordingConfig } from './native-recorder.service.js';

/** Active recording session state */
interface ActiveRecording {
  id: string;
  outputPath: string;
  outputDir: string;
  fileName: string;
  state: RecordingState;
  startedAt: number;
}

// Current active recording (only one at a time)
let activeRecording: ActiveRecording | null = null;

/**
 * Get available desktop sources (monitors)
 * Uses native Rust addon for enumeration
 */
export async function getSources(): Promise<DesktopSource[]> {
  try {
    const monitors = nativeRecorderService.getMonitors();

    return monitors.map((monitor) => ({
      id: `monitor:${monitor.index}`,
      name: monitor.name,
      thumbnailDataUrl: '', // Native recorder doesn't provide thumbnails
      isScreen: true,
      width: monitor.width,
      height: monitor.height,
      isPrimary: monitor.isPrimary,
    }));
  } catch (error) {
    console.error('[RecorderService] Failed to get native sources:', error);
    return [];
  }
}

/**
 * Start a new recording session
 * Uses native Rust recorder (cursor is hidden from recording)
 */
export function startRecording(config: RecordingConfig): StartRecordingResult {
  if (activeRecording) {
    return { success: false, error: 'A recording is already in progress' };
  }

  try {
    const recordingId = randomUUID();

    // Parse monitor index from sourceId (format: "monitor:1")
    const monitorIndex = parseInt(config.sourceId.replace('monitor:', ''), 10) || 1;

    // Build output path
    const ext = '.mp4'; // Native recorder outputs MP4
    let outputPath = path.join(config.outputDir, `${config.fileName}${ext}`);

    // Handle duplicate file names
    let counter = 1;
    while (fs.existsSync(outputPath)) {
      outputPath = path.join(config.outputDir, `${config.fileName}_${counter}${ext}`);
      counter++;
    }

    // Ensure output directory exists
    if (!fs.existsSync(config.outputDir)) {
      fs.mkdirSync(config.outputDir, { recursive: true });
    }

    // Store in database
    createRecording({
      id: recordingId,
      status: 'recording',
      tempPath: outputPath, // Native recorder writes directly to final path
      finalPath: null,
      outputDir: config.outputDir,
      fileName: config.fileName,
      sourceId: config.sourceId,
      startedAt: Date.now(),
      windowBounds: null,
    });

    // Start native recording
    nativeRecorderService.startRecording({
      monitorIndex,
      outputPath,
      frameRate: config.options?.frameRate ?? 30,
      bitrate: config.options?.videoBitrate ?? 8_000_000,
      codec: config.options?.codec as NativeRecordingConfig['codec'],
      width: config.options?.width,
      height: config.options?.height,
    });

    // Set active recording
    activeRecording = {
      id: recordingId,
      outputPath,
      outputDir: config.outputDir,
      fileName: config.fileName,
      state: 'RECORDING' as RecordingState,
      startedAt: Date.now(),
    };

    console.log('[RecorderService] Started native recording:', recordingId);

    // Start mouse tracking for this recording
    mouseTrackerService.startTracking(recordingId);

    return {
      success: true,
      recordingId,
      tempPath: outputPath,
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
 * @deprecated Not used with native recorder - chunks are handled in Rust
 */
export function appendChunk(_recordingId: string, _chunk: Buffer): boolean {
  console.warn('[RecorderService] appendChunk is deprecated with native recorder');
  return true;
}

/**
 * Stop the active recording and finalize the file
 */
export async function stopRecording(recordingId: string): Promise<StopRecordingResult> {
  if (!activeRecording || activeRecording.id !== recordingId) {
    return { success: false, error: 'No active recording with this ID' };
  }

  // Stop mouse tracking and get event count
  const mouseEventCount = mouseTrackerService.stopTracking();
  console.log('[RecorderService] Mouse events recorded:', mouseEventCount);

  try {
    // Stop native recording (this finalizes the file)
    const filePath = nativeRecorderService.stopRecording();

    // Update database
    completeRecording(recordingId, filePath);

    console.log('[RecorderService] Recording saved to:', filePath);

    // Clear active recording
    activeRecording = null;

    return { success: true, filePath };
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

  nativeRecorderService.pauseRecording();
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

  nativeRecorderService.resumeRecording();
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
    bytesWritten: 0, // Native recorder doesn't report bytes in real-time
  };
}

/**
 * Get the temp path for a recording (for crash recovery)
 */
export function getTempPath(recordingId: string): string | null {
  const recording = getRecording(recordingId);
  return recording?.tempPath || null;
}
