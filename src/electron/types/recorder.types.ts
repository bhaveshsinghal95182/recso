/**
 * Type definitions for the recording system
 */

/** Current state of a recording session */
export enum RecordingState {
  IDLE = 'IDLE',
  RECORDING = 'RECORDING',
  PAUSED = 'PAUSED',
}

/** Recording quality/format options */
export interface RecordingOptions {
  /** Video bitrate in bps (browser MediaRecorder) */
  videoBitrate?: number;
  /** Audio bitrate in bps */
  audioBitrate?: number;
}

/** Recording configuration provided when starting */
export interface RecordingConfig {
  sourceId: string;
  outputDir: string;
  fileName: string;
  /** File extension without dot (e.g., 'mp4'). Defaults to 'mp4' */
  fileExtension?: 'mp4' | 'mkv';
  /** Whether to record desktop/system audio */
  recordSystemAudio?: boolean;
  /** Whether to record from the camera as a separate file */
  recordCamera?: boolean;
  /** Whether to record microphone audio (embedded into video files) */
  recordMic?: boolean;
  /** Specific camera device ID (defaults to system default) */
  cameraDeviceId?: string;
  /** Specific microphone device ID (defaults to system default) */
  micDeviceId?: string;
  options?: RecordingOptions;
}

/** Desktop source (screen or window) from desktopCapturer */
export interface DesktopSource {
  id: string;
  name: string;
  thumbnailDataUrl: string;
  isScreen: boolean;
  /** Source origin X in global pixels */
  x?: number;
  /** Source origin Y in global pixels */
  y?: number;
  /** Width in pixels */
  width?: number;
  /** Height in pixels */
  height?: number;
  /** Whether this is the primary monitor */
  isPrimary?: boolean;
}

/** Status of a recording in the database */
export type RecordingStatus = 'recording' | 'paused' | 'completed' | 'failed' | 'orphaned';

/** Recording metadata stored in SQLite */
export interface RecordingMetadata {
  id: string;
  status: RecordingStatus;
  tempPath: string;
  finalPath: string | null;
  outputDir: string;
  fileName: string;
  sourceId: string;
  startedAt: number;
  stoppedAt: number | null;
  windowBounds: {
    width: number;
    height: number;
    isMaximized: boolean;
  } | null;
}

/** State event pushed to renderer */
export interface RecordingStateEvent {
  state: RecordingState;
  recordingId: string | null;
  duration: number;
  bytesWritten: number;
}

/** Result of starting a recording */
export interface StartRecordingResult {
  success: boolean;
  recordingId?: string;
  tempPath?: string;
  error?: string;
}

/** Result of stopping a recording */
export interface StopRecordingResult {
  success: boolean;
  filePath?: string;
  error?: string;
}
