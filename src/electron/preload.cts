const electron = require('electron');
import type { IpcRendererEvent } from 'electron';
import type {
  DesktopSource,
  RecordingConfig,
  RecordingStateEvent,
  StartRecordingResult,
  StopRecordingResult,
} from './types/recorder.types';

// Types for recovery
interface OrphanedRecording {
  id: string;
  tempPath: string;
  fileName: string;
  startedAt: number;
  fileExists: boolean;
  fileSize: number;
}

type RendererLogLevel = 'error' | 'warn' | 'info' | 'debug';

function toSerializableValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'function') {
    return '[Function]';
  }

  if (typeof value === 'symbol') {
    return value.toString();
  }

  if (value && typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }

  return value;
}

function writeRendererLog(level: RendererLogLevel, ...args: unknown[]): void {
  electron.ipcRenderer.send('logging:write', level, ...args.map(toSerializableValue));
}

const originalRendererConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

console.log = (...args: unknown[]): void => {
  writeRendererLog('info', ...args);
  originalRendererConsole.log(...args);
};

console.info = (...args: unknown[]): void => {
  writeRendererLog('info', ...args);
  originalRendererConsole.info(...args);
};

console.warn = (...args: unknown[]): void => {
  writeRendererLog('warn', ...args);
  originalRendererConsole.warn(...args);
};

console.error = (...args: unknown[]): void => {
  writeRendererLog('error', ...args);
  originalRendererConsole.error(...args);
};

console.debug = (...args: unknown[]): void => {
  writeRendererLog('debug', ...args);
  originalRendererConsole.debug(...args);
};

electron.contextBridge.exposeInMainWorld('electron', {
  // Window controls
  window: {
    close: () => electron.ipcRenderer.send('close-window'),
    minimize: () => electron.ipcRenderer.send('minimize-window'),
    maximize: () => electron.ipcRenderer.send('maximize-window'),
    hideToTray: () => electron.ipcRenderer.send('hide-to-tray'),
    isMaximized: (): Promise<boolean> => electron.ipcRenderer.invoke('is-window-maximized'),
    onMaximizeChange: (callback: (isMaximized: boolean) => void) =>
      createSubscription('window-maximized', callback),
  },

  // Recording
  recorder: {
    getSources: (): Promise<DesktopSource[]> => electron.ipcRenderer.invoke('recorder:get-sources'),

    start: (config: RecordingConfig): Promise<StartRecordingResult> =>
      electron.ipcRenderer.invoke('recorder:start', config),

    appendChunk: (recordingId: string, chunk: ArrayBuffer): Promise<boolean> =>
      electron.ipcRenderer.invoke('recorder:append-chunk', recordingId, chunk),

    writeChunk: (
      recordingId: string,
      streamId: string,
      position: number,
      chunk: ArrayBuffer,
    ): Promise<boolean> =>
      electron.ipcRenderer.invoke('recorder:write-chunk', recordingId, streamId, position, chunk),

    stop: (recordingId: string): Promise<StopRecordingResult> =>
      electron.ipcRenderer.invoke('recorder:stop', recordingId),

    pause: (recordingId: string): void => electron.ipcRenderer.send('recorder:pause', recordingId),

    resume: (recordingId: string): void =>
      electron.ipcRenderer.send('recorder:resume', recordingId),

    getState: (): Promise<RecordingStateEvent> => electron.ipcRenderer.invoke('recorder:get-state'),

    onStateChange: (callback: (state: RecordingStateEvent) => void) =>
      createSubscription('recorder:state', callback),

    // Recovery methods
    getOrphans: (): Promise<OrphanedRecording[]> =>
      electron.ipcRenderer.invoke('recorder:get-orphans'),

    recoverOrphan: (
      id: string,
      outputPath: string,
    ): Promise<{ success: boolean; error?: string }> =>
      electron.ipcRenderer.invoke('recorder:recover', id, outputPath),

    deleteOrphan: (id: string): Promise<boolean> =>
      electron.ipcRenderer.invoke('recorder:delete-orphan', id),

    // Settings methods
    showSaveDialog: (defaultName: string): Promise<string | null> =>
      electron.ipcRenderer.invoke('recorder:show-save-dialog', defaultName),

    showOpenDialog: (): Promise<string | null> =>
      electron.ipcRenderer.invoke('recorder:show-open-dialog'),

    getDefaultOutputDir: (): Promise<string> =>
      electron.ipcRenderer.invoke('recorder:get-default-output-dir'),

    validateOutputPath: (outputPath: string): Promise<{ valid: boolean; error?: string }> =>
      electron.ipcRenderer.invoke('recorder:validate-output-path', outputPath),
  },

  // Compositor
  compositor: {
    getConfig: () => electron.ipcRenderer.invoke('compositor:get-config'),

    updateConfig: (updates: Record<string, unknown>) =>
      electron.ipcRenderer.invoke('compositor:update-config', updates),

    setBackground: (imagePath: string | null): Promise<boolean> =>
      electron.ipcRenderer.invoke('compositor:set-background', imagePath),

    getBackground: (): Promise<string | null> =>
      electron.ipcRenderer.invoke('compositor:get-background'),

    setBackgroundColor: (color: string): Promise<boolean> =>
      electron.ipcRenderer.invoke('compositor:set-background-color', color),

    getBackgroundColor: (): Promise<string> =>
      electron.ipcRenderer.invoke('compositor:get-background-color'),

    setCanvasSize: (size: { width: number; height: number }): Promise<boolean> =>
      electron.ipcRenderer.invoke('compositor:set-canvas-size', size),

    getCanvasSize: (): Promise<{ width: number; height: number }> =>
      electron.ipcRenderer.invoke('compositor:get-canvas-size'),

    setLayoutConfig: (config: Record<string, unknown>): Promise<boolean> =>
      electron.ipcRenderer.invoke('compositor:set-layout-config', config),

    getLayoutConfig: (): Promise<{ padding: number; maxScale: number; scaleUp: boolean }> =>
      electron.ipcRenderer.invoke('compositor:get-layout-config'),

    calculateLayout: (
      videoBounds: { x?: number; y?: number; width: number; height: number },
      canvasSize?: { width: number; height: number },
    ): Promise<{ x: number; y: number; width: number; height: number; scale: number }> =>
      electron.ipcRenderer.invoke('compositor:calculate-layout', videoBounds, canvasSize),

    calculateWebcamLayout: (
      canvasSize?: { width: number; height: number },
      request?: {
        anchor?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
        aspectRatio?: number;
        heightRatio?: number;
        marginPx?: number;
      },
    ): Promise<{ x: number; y: number; width: number; height: number; scale: number }> =>
      electron.ipcRenderer.invoke('compositor:calculate-webcam-layout', canvasSize, request),

    resetConfig: () => electron.ipcRenderer.invoke('compositor:reset-config'),

    showBackgroundPicker: (): Promise<string | null> =>
      electron.ipcRenderer.invoke('compositor:show-background-picker'),
  },

  // Editor
  editor: {
    createProject: (recordingId: string) =>
      electron.ipcRenderer.invoke('editor:create-project', recordingId),

    loadProject: (recordingDir: string) =>
      electron.ipcRenderer.invoke('editor:load-project', recordingDir),

    saveProject: (): Promise<boolean> => electron.ipcRenderer.invoke('editor:save-project'),

    getProject: () => electron.ipcRenderer.invoke('editor:get-project'),

    closeProject: (): Promise<boolean> => electron.ipcRenderer.invoke('editor:close-project'),

    getFrameState: (timeMs: number) =>
      electron.ipcRenderer.invoke('editor:get-frame-state', timeMs),

    getCursorAt: (timeMs: number) => electron.ipcRenderer.invoke('editor:get-cursor-at', timeMs),

    updateCursorConfig: (config: Record<string, unknown>) =>
      electron.ipcRenderer.invoke('editor:update-cursor-config', config),

    updateCursorRegionOverride: (cursorOverride: {
      regionId: string;
      startMs: number;
      endMs: number;
      imagePath: string;
    }) => electron.ipcRenderer.invoke('editor:update-cursor-region-override', cursorOverride),

    replaceCursorRegionOverrides: (
      cursorOverrides: {
        regionId: string;
        startMs: number;
        endMs: number;
        imagePath: string;
      }[],
    ) => electron.ipcRenderer.invoke('editor:replace-cursor-region-overrides', cursorOverrides),

    removeCursorRegionOverride: (regionId: string) =>
      electron.ipcRenderer.invoke('editor:remove-cursor-region-override', regionId),

    showCursorPicker: (): Promise<string | null> =>
      electron.ipcRenderer.invoke('editor:show-cursor-picker'),

    updateZoomConfig: (config: Record<string, unknown>) =>
      electron.ipcRenderer.invoke('editor:update-zoom-config', config),

    updateCropConfig: (
      config: { top: number; left: number; bottom: number; right: number } | null,
    ) => electron.ipcRenderer.invoke('editor:update-crop-config', config),

    updateWebcamOverlay: (config: Record<string, unknown>) =>
      electron.ipcRenderer.invoke('editor:update-webcam-overlay', config),

    /** Update project duration */
    updateProjectDuration: (durationMs: number) =>
      electron.ipcRenderer.invoke('editor:update-project-duration', durationMs),

    projectExists: (recordingDir: string): Promise<boolean> =>
      electron.ipcRenderer.invoke('editor:project-exists', recordingDir),

    getSpritesheetMeta: () => electron.ipcRenderer.invoke('editor:get-spritesheet-meta'),

    getSpritesheetPath: (): Promise<string | null> =>
      electron.ipcRenderer.invoke('editor:get-spritesheet-path'),

    generateSpritesheet: (intervalMs?: number) =>
      electron.ipcRenderer.invoke('editor:generate-spritesheet', intervalMs),

    /** Get all cut regions */
    getCuts: () => electron.ipcRenderer.invoke('editor:get-cuts'),

    /** Add a new cut region */
    addCut: (cut: {
      id: string;
      startMs: number;
      endMs: number;
      targets?: { screen: boolean; webcam: boolean };
    }) => electron.ipcRenderer.invoke('editor:add-cut', cut),

    /** Remove a cut region by ID */
    removeCut: (cutId: string) => electron.ipcRenderer.invoke('editor:remove-cut', cutId),

    /** Update a cut region */
    updateCut: (cut: {
      id: string;
      startMs: number;
      endMs: number;
      targets?: { screen: boolean; webcam: boolean };
    }) => electron.ipcRenderer.invoke('editor:update-cut', cut),

    /** Get timeline layers with visibility/order metadata */
    getTimelineLayers: () => electron.ipcRenderer.invoke('editor:get-timeline-layers'),

    /** Update timeline layer visibility */
    updateTimelineLayerVisibility: (
      layerId: 'main' | 'webcam' | 'zoom-screen' | 'zoom-webcam' | 'cursor',
      visible: boolean,
    ) => electron.ipcRenderer.invoke('editor:update-timeline-layer-visibility', layerId, visible),

    /** Update timeline layer hide mode */
    updateTimelineLayerHideMode: (
      layerId: 'main' | 'webcam' | 'zoom-screen' | 'zoom-webcam' | 'cursor',
      hideMode: 'editor-only' | 'render-and-export',
    ) => electron.ipcRenderer.invoke('editor:update-timeline-layer-hide-mode', layerId, hideMode),

    /** Reorder timeline layers by layer ID */
    reorderTimelineLayers: (
      layerIds: ('main' | 'webcam' | 'zoom-screen' | 'zoom-webcam' | 'cursor')[],
    ) => electron.ipcRenderer.invoke('editor:reorder-timeline-layers', layerIds),

    /** Get all zoom regions */
    getZoomRegions: () => electron.ipcRenderer.invoke('editor:get-zoom-regions'),

    /** Get all zoom regions for a specific source timeline */
    getZoomRegionsBySource: (source: 'screen' | 'webcam') =>
      electron.ipcRenderer.invoke('editor:get-zoom-regions-by-source', source),

    /** Add a new zoom region */
    addZoomRegion: (zoom: {
      id: string;
      startMs: number;
      endMs: number;
      zoomLevel: number;
      focalX: number;
      focalY: number;
      easeDurationMs: number;
      focalKeyframes?: { timestampMs: number; focalX: number; focalY: number }[];
      webcamHeightRatio?: number;
    }) => electron.ipcRenderer.invoke('editor:add-zoom-region', zoom),

    /** Add a new zoom region for a specific source timeline */
    addZoomRegionBySource: (
      source: 'screen' | 'webcam',
      zoom: {
        id: string;
        startMs: number;
        endMs: number;
        zoomLevel: number;
        focalX: number;
        focalY: number;
        easeDurationMs: number;
        focalKeyframes?: { timestampMs: number; focalX: number; focalY: number }[];
        webcamHeightRatio?: number;
      },
    ) => electron.ipcRenderer.invoke('editor:add-zoom-region-by-source', source, zoom),

    /** Remove a zoom region by ID */
    removeZoomRegion: (zoomId: string) =>
      electron.ipcRenderer.invoke('editor:remove-zoom-region', zoomId),

    /** Remove a zoom region by ID for a specific source timeline */
    removeZoomRegionBySource: (source: 'screen' | 'webcam', zoomId: string) =>
      electron.ipcRenderer.invoke('editor:remove-zoom-region-by-source', source, zoomId),

    /** Update a zoom region */
    updateZoomRegion: (zoom: {
      id: string;
      startMs: number;
      endMs: number;
      zoomLevel: number;
      focalX: number;
      focalY: number;
      easeDurationMs: number;
      focalKeyframes?: { timestampMs: number; focalX: number; focalY: number }[];
      webcamHeightRatio?: number;
    }) => electron.ipcRenderer.invoke('editor:update-zoom-region', zoom),

    /** Update a zoom region for a specific source timeline */
    updateZoomRegionBySource: (
      source: 'screen' | 'webcam',
      zoom: {
        id: string;
        startMs: number;
        endMs: number;
        zoomLevel: number;
        focalX: number;
        focalY: number;
        easeDurationMs: number;
        focalKeyframes?: { timestampMs: number; focalX: number; focalY: number }[];
        webcamHeightRatio?: number;
      },
    ) => electron.ipcRenderer.invoke('editor:update-zoom-region-by-source', source, zoom),

    /** Update multiple zoom regions at once (bulk) */
    updateZoomRegions: (
      zooms: {
        id: string;
        startMs: number;
        endMs: number;
        zoomLevel: number;
        focalX: number;
        focalY: number;
        easeDurationMs: number;
        focalKeyframes?: { timestampMs: number; focalX: number; focalY: number }[];
        webcamHeightRatio?: number;
      }[],
    ) => electron.ipcRenderer.invoke('editor:update-zoom-regions', zooms),

    /** Update multiple zoom regions for a specific source timeline (bulk) */
    updateZoomRegionsBySource: (
      source: 'screen' | 'webcam',
      zooms: {
        id: string;
        startMs: number;
        endMs: number;
        zoomLevel: number;
        focalX: number;
        focalY: number;
        easeDurationMs: number;
        focalKeyframes?: { timestampMs: number; focalX: number; focalY: number }[];
        webcamHeightRatio?: number;
      }[],
    ) => electron.ipcRenderer.invoke('editor:update-zoom-regions-by-source', source, zooms),

    /** Get mouse events for the active project's recording */
    getMouseEvents: (): Promise<
      {
        id: number;
        recordingId: string;
        timestampMs: number;
        x: number;
        y: number;
        normalizedX?: number;
        normalizedY?: number;
        cursorDataUrl?: string;
        cursorHotspotX?: number;
        cursorHotspotY?: number;
        cursorHandleHex?: string;
        eventType: 'click' | 'mousemove';
        button?: 'left' | 'right' | 'middle';
      }[]
    > => electron.ipcRenderer.invoke('editor:get-mouse-events'),
  },

  // Background configuration
  background: {
    /** Update background color for the active project */
    updateColor: (color: string) => electron.ipcRenderer.invoke('background:update-color', color),

    /** Update background image path for the active project */
    updatePath: (imagePath: string | null) =>
      electron.ipcRenderer.invoke('background:update-path', imagePath),

    /** Update background pattern for the active project */
    updatePattern: (pattern: Record<string, unknown> | null) =>
      electron.ipcRenderer.invoke('background:update-pattern', pattern),

    /** Update active background mode for the project */
    updateMode: (mode: 'color' | 'pattern' | 'image') =>
      electron.ipcRenderer.invoke('background:update-mode', mode),

    /** Update whether canvas background is enabled for the active project */
    updateCanvasBackgroundEnabled: (enabled: boolean) =>
      electron.ipcRenderer.invoke('background:update-canvas-background-enabled', enabled),

    /** Get current background configuration */
    getConfig: () => electron.ipcRenderer.invoke('background:get-config'),
  },

  // Exporter
  exporter: {
    /** Get exports folder path */
    getExportsFolder: (): Promise<string | null> =>
      electron.ipcRenderer.invoke('exporter:get-exports-folder'),

    /** Open exports folder in file explorer */
    openExportsFolder: (): Promise<boolean> =>
      electron.ipcRenderer.invoke('exporter:open-exports-folder'),

    /** Show file in folder */
    showInFolder: (filePath: string): Promise<boolean> =>
      electron.ipcRenderer.invoke('exporter:show-in-folder', filePath),

    /** Open file with the default system application */
    openFile: (filePath: string): Promise<boolean> =>
      electron.ipcRenderer.invoke('exporter:open-file', filePath),

    /** Resolve output path using exporter naming rules */
    resolveOutputPath: (config: Record<string, unknown>): Promise<string | null> =>
      electron.ipcRenderer.invoke('exporter:resolve-output-path', config),

    /** Persist renderer-produced output bytes to disk */
    writeOutputFile: (
      outputPath: string,
      data: ArrayBuffer,
    ): Promise<{ success: boolean; outputPath?: string; fileSize?: number; error?: string }> =>
      electron.ipcRenderer.invoke('exporter:write-output-file', outputPath, data),
  },

  // Debug tools
  debug: {
    getMouseStatus: () => electron.ipcRenderer.invoke('debug:get-mouse-status'),
  },

  // Telemetry & Support
  telemetry: {
    /** Get the persistent hardware-based support ID for this device */
    getSupportId: (): Promise<string> => electron.ipcRenderer.invoke('telemetry:get-support-id'),

    /** Send an error report from the renderer to the main process */
    logError: (error: {
      message: string;
      stack?: string;
      componentStack?: string;
      source?: string;
    }): void => electron.ipcRenderer.send('telemetry:log-error', error),
  },

  // Recent Projects
  recentProjects: {
    getAll: (limit?: number): Promise<unknown[]> =>
      electron.ipcRenderer.invoke('recent-projects:get', limit),

    remove: (id: string): Promise<boolean> =>
      electron.ipcRenderer.invoke('recent-projects:remove', id),

    clear: (): Promise<boolean> => electron.ipcRenderer.invoke('recent-projects:clear'),
  },

  // Logging
  logging: {
    info: (...args: unknown[]): void => writeRendererLog('info', ...args),
    warn: (...args: unknown[]): void => writeRendererLog('warn', ...args),
    error: (...args: unknown[]): void => writeRendererLog('error', ...args),
    debug: (...args: unknown[]): void => writeRendererLog('debug', ...args),
  },
});

// Helper to create a subscription that returns an unsubscribe function
function createSubscription<T>(channel: string, callback: (data: T) => void) {
  const handler = (_event: IpcRendererEvent, data: T) => callback(data);
  electron.ipcRenderer.on(channel, handler);
  // Return unsubscribe function
  return () => electron.ipcRenderer.removeListener(channel, handler);
}
