/**
 * Type declarations for Electron IPC bridge
 * These types mirror what's exposed in preload.cts
 */

interface Statistics {
  cpu: number;
  ram: number;
  storage: number;
}

interface StaticData {
  totalStorage: number;
  cpuModel: string;
  totalRAM: number;
}

// Recording types
interface DesktopSource {
  id: string;
  name: string;
  thumbnailDataUrl: string;
  isScreen: boolean;
}

interface RecordingConfig {
  sourceId: string;
  outputDir: string;
  fileName: string;
  options?: {
    frameRate?: number;
    videoBitrate?: number;
    audioBitrate?: number;
  };
}

interface RecordingStateEvent {
  state: 'IDLE' | 'RECORDING' | 'PAUSED';
  recordingId: string | null;
  duration: number;
  bytesWritten: number;
}

interface StartRecordingResult {
  success: boolean;
  recordingId?: string;
  tempPath?: string;
  error?: string;
}

interface StopRecordingResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

interface OrphanedRecording {
  id: string;
  tempPath: string;
  fileName: string;
  startedAt: number;
  fileExists: boolean;
  fileSize: number;
  /** Warning message if file couldn't be accessed (locked, corrupted, etc.) */
  warning: string | null;
}

interface ElectronAPI {
  window: {
    close: () => void;
    minimize: () => void;
    maximize: () => void;
    hideToTray: () => void;
  };

  stats: {
    /** Subscribe to live statistics. Returns an unsubscribe function. */
    subscribe: (callback: (stats: Statistics) => void) => () => void;
    getStatic: () => Promise<StaticData>;
  };

  recorder: {
    /** Get available screens and windows for recording */
    getSources: () => Promise<DesktopSource[]>;

    /** Start a new recording session */
    start: (config: RecordingConfig) => Promise<StartRecordingResult>;

    /** Append a video chunk to the active recording */
    appendChunk: (recordingId: string, chunk: ArrayBuffer) => Promise<boolean>;

    /** Stop the recording and save the file */
    stop: (recordingId: string) => Promise<StopRecordingResult>;

    /** Pause the active recording */
    pause: (recordingId: string) => void;

    /** Resume a paused recording */
    resume: (recordingId: string) => void;

    /** Get current recording state */
    getState: () => Promise<RecordingStateEvent>;

    /** Subscribe to recording state changes */
    onStateChange: (callback: (state: RecordingStateEvent) => void) => () => void;

    /** Get list of orphaned recordings from crashes */
    getOrphans: () => Promise<OrphanedRecording[]>;

    /** Recover an orphaned recording */
    recoverOrphan: (
      id: string,
      outputPath: string,
    ) => Promise<{ success: boolean; error?: string }>;

    /** Delete an orphaned recording */
    deleteOrphan: (id: string) => Promise<boolean>;

    /** Open native save dialog for recording */
    showSaveDialog: (defaultName: string) => Promise<string | null>;

    /** Get default output directory (Videos folder) */
    getDefaultOutputDir: () => Promise<string>;

    /** Validate if output path is writable */
    validateOutputPath: (outputPath: string) => Promise<{ valid: boolean; error?: string }>;
  };
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
