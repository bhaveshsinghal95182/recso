import { app } from 'electron';

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  isCursorSettingsSupported,
  listAvailableWindows,
  startMonitorRecording,
  startWindowRecording,
  type Stopper,
  type WindowInfo,
} from 'velocity';

import type {
  RecordingConfig,
  RecordingStateEvent,
  StartRecordingResult,
  StopRecordingResult,
} from '../../types/recorder.types.js';
import { RecordingState } from '../../types/recorder.types.js';
import { completeRecording, createRecording } from '../database.service.js';
import { initProjectFolder } from '../project-storage.service.js';

interface ActiveRecording {
  id: string;
  outputDir: string;
  fileName: string;
  fileExtension: 'mp4' | 'webm' | 'mkv';
  state: RecordingState;
  startedAt: number;
  stopper: Stopper;
  tempPath: string;
}

let activeRecording: ActiveRecording | null = null;

export function checkCursorSettingsSupported(): boolean {
  return isCursorSettingsSupported();
}

export function getAvailableWindows(): WindowInfo[] {
  return listAvailableWindows();
}

export function recordMonitor(config: RecordingConfig, bitrate: number): StartRecordingResult {
  if (activeRecording) {
    return { success: false, error: 'A recording is already in progress' };
  }

  try {
    const recordingId = randomUUID();
    const fileExt = config.fileExtension || 'mp4';
    const tempDir = path.join(app.getPath('temp'), 'recso');
    const tempPath = path.join(tempDir, `rec_vel_${recordingId}.${fileExt}`);

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    createRecording({
      id: recordingId,
      status: 'recording',
      tempPath,
      finalPath: null,
      outputDir: config.outputDir,
      fileName: config.fileName,
      sourceId: config.sourceId,
      startedAt: Date.now(),
      windowBounds: null,
    });

    const stopper = startMonitorRecording(tempPath, bitrate);

    activeRecording = {
      id: recordingId,
      outputDir: config.outputDir,
      fileName: config.fileName,
      fileExtension: fileExt as 'mp4' | 'webm' | 'mkv',
      state: RecordingState.RECORDING,
      startedAt: Date.now(),
      stopper,
      tempPath,
    };

    console.log('[VelocityRecorderService] Started monitor recording:', recordingId);

    return {
      success: true,
      recordingId,
      tempPath,
    };
  } catch (error) {
    console.error('[VelocityRecorderService] Failed to start monitor recording:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export function recordWindow(
  windowTitle: string,
  config: RecordingConfig,
  bitrate: number,
): StartRecordingResult {
  if (activeRecording) {
    return { success: false, error: 'A recording is already in progress' };
  }

  try {
    const recordingId = randomUUID();
    const fileExt = config.fileExtension || 'mp4';
    const tempDir = path.join(app.getPath('temp'), 'recso');
    const tempPath = path.join(tempDir, `rec_vel_${recordingId}.${fileExt}`);

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    createRecording({
      id: recordingId,
      status: 'recording',
      tempPath,
      finalPath: null,
      outputDir: config.outputDir,
      fileName: config.fileName,
      sourceId: config.sourceId,
      startedAt: Date.now(),
      windowBounds: null,
    });

    const stopper = startWindowRecording(windowTitle, tempPath, bitrate);

    activeRecording = {
      id: recordingId,
      outputDir: config.outputDir,
      fileName: config.fileName,
      fileExtension: fileExt as 'mp4' | 'webm' | 'mkv',
      state: RecordingState.RECORDING,
      startedAt: Date.now(),
      stopper,
      tempPath,
    };

    console.log('[VelocityRecorderService] Started window recording:', recordingId);

    return {
      success: true,
      recordingId,
      tempPath,
    };
  } catch (error) {
    console.error('[VelocityRecorderService] Failed to start window recording:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function stopRecording(recordingId: string): Promise<StopRecordingResult> {
  if (!activeRecording || activeRecording.id !== recordingId) {
    return { success: false, error: 'No active recording with this ID' };
  }

  try {
    activeRecording.stopper.stop();

    // Wait briefly for the file handle to close naturally from rust (optional depending on engine speed)
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Ensure root output directory exists
    if (!fs.existsSync(activeRecording.outputDir)) {
      fs.mkdirSync(activeRecording.outputDir, { recursive: true });
    }

    let folderName = activeRecording.fileName;
    let recordingFolderPath = path.join(activeRecording.outputDir, folderName);
    let counter = 1;

    while (fs.existsSync(recordingFolderPath)) {
      folderName = `${activeRecording.fileName}_${counter}`;
      recordingFolderPath = path.join(activeRecording.outputDir, folderName);
      counter++;
    }

    fs.mkdirSync(recordingFolderPath, { recursive: true });
    initProjectFolder(recordingFolderPath);

    const ext = `.${activeRecording.fileExtension}`;
    const finalPath = path.join(recordingFolderPath, `${folderName}${ext}`);

    // If we're mp4, should we remux? Velocity outputs mp4 directly, metadata is usually fine via mfplat, but let's check size
    let stats = fs.statSync(activeRecording.tempPath);
    if (stats.size === 0) {
      console.error('[VelocityRecorderService] WARNING: Recording resulted in 0-byte file!');
    } else {
      console.log('[VelocityRecorderService] Recording finished. Size:', stats.size);
    }

    // Move
    fs.renameSync(activeRecording.tempPath, finalPath);
    completeRecording(recordingId, finalPath);

    console.log('[VelocityRecorderService] Recording saved to:', finalPath);
    activeRecording = null;

    return { success: true, filePath: finalPath };
  } catch (error) {
    console.error('[VelocityRecorderService] Failed to stop recording:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

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
  let bytesWritten = 0;
  try {
    const stats = fs.statSync(activeRecording.tempPath);
    bytesWritten = stats.size;
  } catch {
    //
  }

  return {
    state: activeRecording.state,
    recordingId: activeRecording.id,
    duration,
    bytesWritten,
  };
}
