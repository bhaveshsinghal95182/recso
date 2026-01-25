/**
 * RecoveryService — quick overview:
 * - Detects orphaned recordings on app startup (recordings that weren't properly closed).
 * - Provides info to frontend including file existence, size, and access warnings.
 * - Allows recovery (move temp → output) or deletion of orphaned recordings.
 *
 * Key exports:
 *   checkForOrphans()           → Returns list of incomplete recordings with file status
 *   recoverRecording(id, path)  → Move temp file to output path
 *   deleteOrphanedRecording(id) → Clean up temp file and DB entry
 *   getOrphanDetails()          → Alias for checkForOrphans()
 */

import fs from 'fs';

import {
  deleteRecording,
  getOrphanedRecordings,
  updateRecordingStatus,
} from './database.service.js';

export interface OrphanedRecording {
  id: string;
  tempPath: string;
  fileName: string;
  startedAt: number;
  fileExists: boolean;
  fileSize: number;
  warning: string | null;
}

/**
 * Check for orphaned recordings on app startup
 * Returns list of recoverable recordings
 */
export function checkForOrphans(): OrphanedRecording[] {
  const orphans = getOrphanedRecordings();

  return orphans.map((recording) => {
    const fileExists = fs.existsSync(recording.tempPath);
    let fileSize = 0;
    let warning: string | null = null;

    if (fileExists) {
      try {
        const stats = fs.statSync(recording.tempPath);
        fileSize = stats.size;
      } catch (error) {
        warning =
          error instanceof Error
            ? `File access error: ${error.message}`
            : 'File might be locked or corrupted';
      }
    } else {
      warning = 'Temp file no longer exists on disk';
    }

    // Mark as orphaned in database
    updateRecordingStatus(recording.id, 'orphaned');

    return {
      id: recording.id,
      tempPath: recording.tempPath,
      fileName: recording.fileName,
      startedAt: recording.startedAt,
      fileExists,
      fileSize,
      warning,
    };
  });
}

/**
 * Recover an orphaned recording
 * Moves the temp file to the output location
 * Note: Full FFmpeg repair will be added in a later phase
 */
export function recoverRecording(
  id: string,
  outputPath: string,
): { success: boolean; error?: string } {
  const orphans = getOrphanedRecordings();
  const recording = orphans.find((r) => r.id === id);

  if (!recording) {
    return { success: false, error: 'Recording not found' };
  }

  if (!fs.existsSync(recording.tempPath)) {
    deleteRecording(id);
    return { success: false, error: 'Temp file no longer exists' };
  }

  try {
    // Ensure output directory exists
    const outputDir = outputPath.substring(0, outputPath.lastIndexOf('/'));
    if (outputDir && !fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Move temp file to output location
    fs.renameSync(recording.tempPath, outputPath);

    // Update database
    updateRecordingStatus(id, 'completed');

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Delete an orphaned recording and clean up
 */
export function deleteOrphanedRecording(id: string): boolean {
  const orphans = getOrphanedRecordings();
  const recording = orphans.find((r) => r.id === id);

  if (!recording) {
    return false;
  }

  // Delete temp file if it exists
  if (fs.existsSync(recording.tempPath)) {
    try {
      fs.unlinkSync(recording.tempPath);
    } catch {
      // File might be locked
    }
  }

  // Delete from database
  deleteRecording(id);

  return true;
}

/**
 * Get details of all orphaned recordings
 */
export function getOrphanDetails(): OrphanedRecording[] {
  return checkForOrphans();
}
