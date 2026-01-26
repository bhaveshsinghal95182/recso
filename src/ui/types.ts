export interface DesktopSource {
  id: string;
  name: string;
  thumbnailDataUrl: string;
  isScreen: boolean;
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

export interface RecordingOptions {
  frameRate?: number;
  videoBitrate?: number;
  audioBitrate?: number;
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
