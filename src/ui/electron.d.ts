import type { WindowInfo } from '../electron/types/velocity.types';
import type { BackgroundPatternConfig } from '../shared/patterns';
import type {
  CursorConfig,
  CutRegion,
  DesktopSource,
  ExportConfig,
  ExportProgress,
  ExportResult,
  ExportState,
  FrameState,
  OrphanedRecording,
  Project,
  RecordedMouseEvent,
  RecordingConfig,
  SpritesheetMeta,
  StartRecordingResult,
  StopRecordingResult,
  TransformedCursorPosition,
  ZoomConfig,
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

  editor: {
    /** Create a new project from a recording ID */
    createProject: (recordingId: string) => Promise<Project | null>;

    /** Load an existing project from recording directory */
    loadProject: (recordingDir: string) => Promise<Project | null>;

    /** Save the active project to .recso folder */
    saveProject: () => Promise<boolean>;

    /** Get the active project */
    getProject: () => Promise<Project | null>;

    /** Close the active project */
    closeProject: () => Promise<boolean>;

    /** Get frame state at a specific time */
    getFrameState: (timeMs: number) => Promise<FrameState>;

    /** Get cursor position at a specific time */
    getCursorAt: (timeMs: number) => Promise<TransformedCursorPosition | null>;

    /** Update cursor configuration */
    updateCursorConfig: (config: Partial<CursorConfig>) => Promise<CursorConfig | undefined>;

    /** Update zoom configuration */
    updateZoomConfig: (config: Partial<ZoomConfig>) => Promise<ZoomConfig | undefined>;

    /** Update project duration */
    updateProjectDuration: (durationMs: number) => Promise<boolean>;

    /** Check if a project exists for recording directory */
    projectExists: (recordingDir: string) => Promise<boolean>;

    /** Get spritesheet metadata */
    getSpritesheetMeta: () => Promise<SpritesheetMeta | null>;

    /** Get spritesheet image path */
    getSpritesheetPath: () => Promise<string | null>;

    /** Generate spritesheet for timeline thumbnails */
    generateSpritesheet: (intervalMs?: number) => Promise<SpritesheetMeta | null>;

    /** Get all cut regions */
    getCuts: () => Promise<CutRegion[]>;

    /** Add a new cut region */
    addCut: (cut: CutRegion) => Promise<boolean>;

    /** Remove a cut region by ID */
    removeCut: (cutId: string) => Promise<boolean>;

    /** Update a cut region */
    updateCut: (cut: CutRegion) => Promise<boolean>;

    /** Get all zoom regions */
    getZoomRegions: () => Promise<ZoomRegion[]>;

    /** Add a new zoom region */
    addZoomRegion: (zoom: ZoomRegion) => Promise<boolean>;

    /** Remove a zoom region by ID */
    removeZoomRegion: (zoomId: string) => Promise<boolean>;

    /** Update a zoom region */
    updateZoomRegion: (zoom: ZoomRegion) => Promise<boolean>;

    /** Update multiple zoom regions at once (bulk) */
    updateZoomRegions: (zooms: ZoomRegion[]) => Promise<boolean>;

    /** Get mouse events for the active project's recording */
    getMouseEvents: () => Promise<RecordedMouseEvent[]>;

    /** Get precomputed cursor frames for preview player */
    getPrecomputedCursor: (options: {
      fps: number;
      totalFrames: number;
      canvasWidth: number;
      canvasHeight: number;
      layout: { x: number; y: number; width: number; height: number; scale: number };
    }) => Promise<{
      frames: Array<{ x: number; y: number; scale: number; opacity: number; isClick: boolean }>;
      sizeMultiplier: number;
    } | null>;
  };

  background: {
    /** Update background color for the active project */
    updateColor: (color: string) => Promise<{ success: boolean; color: string }>;

    /** Update background pattern for the active project */
    updatePattern: (
      pattern: BackgroundPatternConfig | null,
    ) => Promise<{ success: boolean; pattern: BackgroundPatternConfig | null }>;

    /** Get current background configuration */
    getConfig: () => Promise<{
      backgroundColor: string;
      backgroundPattern: BackgroundPatternConfig | null;
    }>;
  };

  exporter: {
    /** Start export with configuration */
    start: (config: ExportConfig) => Promise<ExportResult>;

    /** Cancel ongoing export */
    cancel: () => Promise<boolean>;

    /** Get current progress */
    getProgress: () => Promise<ExportProgress | null>;

    /** Get current export state */
    getState: () => Promise<ExportState>;

    /** Get current job info */
    getJob: () => Promise<{
      id: string;
      projectId: string;
      state: ExportState;
      config: ExportConfig;
      outputPath: string;
      progress: ExportProgress;
      startedAt: number;
      error?: string;
    } | null>;

    /** Get exports folder path */
    getExportsFolder: () => Promise<string | null>;

    /** Open exports folder in file explorer */
    openExportsFolder: () => Promise<boolean>;

    /** Show file in folder */
    showInFolder: (filePath: string) => Promise<boolean>;

    /** Subscribe to progress updates */
    onProgress: (callback: (progress: ExportProgress) => void) => () => void;
  };

  velocity: {
    isCursorSettingsSupported: () => Promise<boolean>;
    listAvailableWindows: () => Promise<WindowInfo[]>;
    startMonitorRecording: (
      config: RecordingConfig,
      bitrate: number,
    ) => Promise<StartRecordingResult>;
    startWindowRecording: (
      windowTitle: string,
      config: RecordingConfig,
      bitrate: number,
    ) => Promise<StartRecordingResult>;
    stopRecording: (recordingId: string) => Promise<StopRecordingResult>;
    getMouseEvents: (recordingId: string) => Promise<any[]>;
  };
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
