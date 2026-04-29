import type { BackgroundPatternConfig } from '../shared/patterns';
import type {
  CursorConfig,
  CursorRegionOverride,
  CutRegion,
  DesktopSource,
  ExportConfig,
  FrameState,
  OrphanedRecording,
  Project,
  RecordedMouseEvent,
  RecordingConfig,
  SpritesheetMeta,
  StartRecordingResult,
  StopRecordingResult,
  TimelineLayer,
  TimelineLayerId,
  TimelineVisibilityMode,
  TransformedCursorPosition,
  WebcamOverlayConfig,
  ZoomConfig,
  ZoomRegion,
  ZoomSource,
} from './types';

// State event specific to IPC (contains uppercase State status)
export interface RecordingStateEvent {
  state: 'IDLE' | 'RECORDING' | 'PAUSED';
  recordingId: string | null;
  duration: number;
  bytesWritten: number;
}

export interface RecentProject {
  id: string;
  name: string;
  path: string;
  recordingId: string;
  thumbnail: string | null;
  openedAt: number;
  createdAt: number;
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

    /** Append a video chunk to the active recording (legacy sequential) */
    appendChunk: (recordingId: string, chunk: ArrayBuffer) => Promise<boolean>;

    /** Write a chunk at a specific byte offset to a specific stream (mediabunny StreamTarget) */
    writeChunk: (
      recordingId: string,
      streamId: string,
      position: number,
      chunk: ArrayBuffer,
    ) => Promise<boolean>;

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

    /** Calculate layout for webcam overlay on canvas */
    calculateWebcamLayout: (
      canvasSize?: { width: number; height: number },
      request?: {
        anchor?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
        aspectRatio?: number;
        heightRatio?: number;
        marginPx?: number;
      },
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

    /** Upsert cursor image override for a timeline cursor region */
    updateCursorRegionOverride: (
      cursorOverride: CursorRegionOverride,
    ) => Promise<CursorRegionOverride[]>;

    /** Replace all cursor image overrides for timeline regions */
    replaceCursorRegionOverrides: (
      cursorOverrides: CursorRegionOverride[],
    ) => Promise<CursorRegionOverride[]>;

    /** Remove cursor image override for a timeline cursor region */
    removeCursorRegionOverride: (regionId: string) => Promise<CursorRegionOverride[]>;

    /** Open file picker for custom cursor image */
    showCursorPicker: () => Promise<string | null>;

    /** Update zoom configuration */
    updateZoomConfig: (config: Partial<ZoomConfig>) => Promise<ZoomConfig | undefined>;

    /** Update webcam overlay configuration */
    updateWebcamOverlay: (
      config: Partial<WebcamOverlayConfig>,
    ) => Promise<WebcamOverlayConfig | null | undefined>;

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

    /** Get timeline layers with visibility/order metadata */
    getTimelineLayers: () => Promise<TimelineLayer[]>;

    /** Update timeline layer visibility */
    updateTimelineLayerVisibility: (
      layerId: TimelineLayerId,
      visible: boolean,
    ) => Promise<TimelineLayer[] | null>;

    /** Update timeline layer hide mode */
    updateTimelineLayerHideMode: (
      layerId: TimelineLayerId,
      hideMode: TimelineVisibilityMode,
    ) => Promise<TimelineLayer[] | null>;

    /** Reorder timeline layers by ID */
    reorderTimelineLayers: (layerIds: TimelineLayerId[]) => Promise<TimelineLayer[] | null>;

    /** Get all zoom regions */
    getZoomRegions: () => Promise<ZoomRegion[]>;

    /** Get all zoom regions for a specific source timeline */
    getZoomRegionsBySource: (source: ZoomSource) => Promise<ZoomRegion[]>;

    /** Add a new zoom region */
    addZoomRegion: (zoom: ZoomRegion) => Promise<boolean>;

    /** Add a new zoom region for a specific source timeline */
    addZoomRegionBySource: (source: ZoomSource, zoom: ZoomRegion) => Promise<boolean>;

    /** Remove a zoom region by ID */
    removeZoomRegion: (zoomId: string) => Promise<boolean>;

    /** Remove a zoom region by ID for a specific source timeline */
    removeZoomRegionBySource: (source: ZoomSource, zoomId: string) => Promise<boolean>;

    /** Update a zoom region */
    updateZoomRegion: (zoom: ZoomRegion) => Promise<boolean>;

    /** Update a zoom region for a specific source timeline */
    updateZoomRegionBySource: (source: ZoomSource, zoom: ZoomRegion) => Promise<boolean>;

    /** Update multiple zoom regions at once (bulk) */
    updateZoomRegions: (zooms: ZoomRegion[]) => Promise<boolean>;

    /** Update multiple zoom regions for a specific source timeline (bulk) */
    updateZoomRegionsBySource: (source: ZoomSource, zooms: ZoomRegion[]) => Promise<boolean>;

    /** Get mouse events for the active project's recording */
    getMouseEvents: () => Promise<RecordedMouseEvent[]>;
  };

  background: {
    /** Update background color for the active project */
    updateColor: (color: string) => Promise<{ success: boolean; color: string }>;

    /** Update background path for the active project */
    updatePath: (path: string | null) => Promise<{ success: boolean; path: string | null }>;

    /** Update background pattern for the active project */
    updatePattern: (
      pattern: BackgroundPatternConfig | null,
    ) => Promise<{ success: boolean; pattern: BackgroundPatternConfig | null }>;

    /** Get current background configuration */
    getConfig: () => Promise<{
      backgroundPath: string | null;
      backgroundColor: string;
      backgroundPattern: BackgroundPatternConfig | null;
    }>;
  };

  exporter: {
    /** Get exports folder path */
    getExportsFolder: () => Promise<string | null>;

    /** Open exports folder in file explorer */
    openExportsFolder: () => Promise<boolean>;

    /** Show file in folder */
    showInFolder: (filePath: string) => Promise<boolean>;

    /** Open file with the default system application */
    openFile: (filePath: string) => Promise<boolean>;

    /** Resolve output path using exporter naming rules */
    resolveOutputPath: (config: ExportConfig) => Promise<string | null>;

    /** Persist renderer-produced output bytes to disk */
    writeOutputFile: (
      outputPath: string,
      data: ArrayBuffer,
    ) => Promise<{ success: boolean; outputPath?: string; fileSize?: number; error?: string }>;
  };

  telemetry: {
    /** Get the persistent hardware-based support ID for this device */
    getSupportId: () => Promise<string>;

    /** Send an error report from the renderer to the main process */
    logError: (error: {
      message: string;
      stack?: string;
      componentStack?: string;
      source?: string;
    }) => void;
  };

  recentProjects: {
    /** Get the most recently opened projects */
    getAll: (limit?: number) => Promise<RecentProject[]>;

    /** Remove a recent project entry by ID */
    remove: (id: string) => Promise<boolean>;

    /** Clear all recent projects */
    clear: () => Promise<boolean>;
  };

  logging: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
