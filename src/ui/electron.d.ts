import type {
  DesktopSource,
  OrphanedRecording,
  RecordingConfig,
  StartRecordingResult,
  StaticData,
  Statistics,
  StopRecordingResult,
} from './types';

// State event specific to IPC (contains uppercase State status)
export interface RecordingStateEvent {
  state: 'IDLE' | 'RECORDING' | 'PAUSED';
  recordingId: string | null;
  duration: number;
  bytesWritten: number;
}

interface ElectronAPI {
  window: {
    close: () => void;
    minimize: () => void;
    maximize: () => void;
    hideToTray: () => void;
    isMaximized: () => Promise<boolean>;
    onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void;
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

    /** Open native directory picker */
    showOpenDialog: () => Promise<string | null>;

    /** Get default output directory (Videos folder) */
    getDefaultOutputDir: () => Promise<string>;

    /** Validate if output path is writable */
    validateOutputPath: (outputPath: string) => Promise<{ valid: boolean; error?: string }>;
  };

  compositor: {
    /** Get full compositor configuration */
    getConfig: () => Promise<{
      backgroundPath: string | null;
      backgroundColor: string;
      canvasSize: { width: number; height: number };
      layout: { padding: number; maxScale: number; scaleUp: boolean };
    }>;

    /** Update compositor configuration (partial) */
    updateConfig: (updates: Record<string, unknown>) => Promise<{
      backgroundPath: string | null;
      backgroundColor: string;
      canvasSize: { width: number; height: number };
      layout: { padding: number; maxScale: number; scaleUp: boolean };
    }>;

    /** Set background image path */
    setBackground: (imagePath: string | null) => Promise<boolean>;

    /** Get current background image path */
    getBackground: () => Promise<string | null>;

    /** Set background color (used when no image) */
    setBackgroundColor: (color: string) => Promise<boolean>;

    /** Get background color */
    getBackgroundColor: () => Promise<string>;

    /** Set target canvas size */
    setCanvasSize: (size: { width: number; height: number }) => Promise<boolean>;

    /** Get target canvas size */
    getCanvasSize: () => Promise<{ width: number; height: number }>;

    /** Set layout configuration */
    setLayoutConfig: (
      config: Partial<{ padding: number; maxScale: number; scaleUp: boolean }>,
    ) => Promise<boolean>;

    /** Get layout configuration */
    getLayoutConfig: () => Promise<{ padding: number; maxScale: number; scaleUp: boolean }>;

    /** Calculate layout for video on canvas */
    calculateLayout: (
      videoBounds: { x?: number; y?: number; width: number; height: number },
      canvasSize?: { width: number; height: number },
    ) => Promise<{ x: number; y: number; width: number; height: number; scale: number }>;

    /** Reset configuration to defaults */
    resetConfig: () => Promise<{
      backgroundPath: string | null;
      backgroundColor: string;
      canvasSize: { width: number; height: number };
      layout: { padding: number; maxScale: number; scaleUp: boolean };
    }>;

    /** Open file picker for background image */
    showBackgroundPicker: () => Promise<string | null>;
  };
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
