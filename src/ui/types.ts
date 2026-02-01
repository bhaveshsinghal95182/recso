export interface DesktopSource {
  id: string;
  name: string;
  /** Monitor width in pixels */
  width?: number;
  /** Monitor height in pixels */
  height?: number;
  /** Whether this is the primary display */
  isPrimary?: boolean;
}

export interface RecorderState {
  status: 'idle' | 'recording' | 'paused';
  recordingId: string | null;
  duration: number;
  bytesWritten: number;
}

export interface UseScreenRecorderOptions {
  /** Chunk interval in ms (default: 1000) */
  timeslice?: number;
  /** Video frame rate (default: 30) */
  frameRate?: number;
  /** Include system audio */
  audio?: boolean;
}

// --- Types mirrored from Backend ---

/** Video codec for recording */
export type VideoCodec = 'H264' | 'Hevc' | 'Vp9';

export interface RecordingOptions {
  frameRate?: number;
  videoBitrate?: number;
  audioBitrate?: number;
  codec?: VideoCodec;
  width?: number;
  height?: number;
}

export interface RecordingConfig {
  sourceId: string;
  outputDir: string;
  fileName: string;
  options?: RecordingOptions;
}

export interface StartRecordingResult {
  success: boolean;
  recordingId?: string;
  tempPath?: string;
  error?: string;
}

export interface StopRecordingResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

export interface Statistics {
  cpu: number;
  ram: number;
  storage: number;
}

export interface StaticData {
  totalStorage: number;
  cpuModel: string;
  totalRAM: number;
}

export interface OrphanedRecording {
  id: string;
  tempPath: string;
  fileName: string;
  startedAt: number;
  fileExists: boolean;
  fileSize: number;
  warning: string | null;
}
