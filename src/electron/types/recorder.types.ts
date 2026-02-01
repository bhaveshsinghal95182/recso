/**
 * Type definitions for the recording system
 */

/** Current state of a recording session */
export enum RecordingState {
  IDLE = 'IDLE',
  RECORDING = 'RECORDING',
  PAUSED = 'PAUSED',
}

/** Video codec for recording - values match velocity.VideoCodec enum */
export type VideoCodec = 'H264' | 'Hevc' | 'Vp9';

/** Recording quality/format options */
export interface RecordingOptions {
  frameRate?: number;
  videoBitrate?: number;
  audioBitrate?: number;
  /** Video codec (default: H264) */
  codec?: VideoCodec;
  /** Output width for resolution scaling */
  width?: number;
  /** Output height for resolution scaling */
  height?: number;
}

/** Recording configuration provided when starting */
export interface RecordingConfig {
  sourceId: string;
  outputDir: string;
  fileName: string;
  options?: RecordingOptions;
}

/** Desktop source (screen or window) from desktopCapturer or native recorder */
export interface DesktopSource {
  id: string;
  name: string;
  thumbnailDataUrl: string;
  isScreen: boolean;
  /** Width in pixels (available for native monitors) */
  width?: number;
  /** Height in pixels (available for native monitors) */
  height?: number;
  /** Whether this is the primary monitor (available for native monitors) */
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
