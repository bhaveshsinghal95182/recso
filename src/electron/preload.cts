const electron = require('electron');
import type { IpcRendererEvent } from 'electron';
import type { engineBridge as EngineBridge } from './preload-engine.cjs';

/**
 * The GPU engine bridge, or a stub if it could not load.
 *
 * Kept in its own module because it installs the shared-texture receiver at
 * load time and paints frames inside the isolated world -- see that file's
 * header. Loaded defensively on purpose: it is an optional path, and an
 * exception escaping it here would take the whole `window.electron` bridge
 * down with it, breaking recording and editing along with the preview.
 */
function loadEngineBridge(): typeof EngineBridge {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bridge = require('./preload-engine.cjs').engineBridge as typeof EngineBridge;
    console.info('[engine-debug] engine bridge loaded');
    return bridge;
  } catch (error) {
    const message = 'engine bridge failed to load: ' + (error as Error).message;
    console.error('[engine-debug] engine bridge failed to load', error);
    const unavailable = () => Promise.reject(new Error(message));
    const invoke = electron.ipcRenderer.invoke.bind(electron.ipcRenderer);

    return {
      // A sandboxed preload cannot receive shared textures, so the preview is
      // unavailable. Plain IPC still works: diagnostics and native export stay
      // usable without giving the application renderer Node privileges.
      status: async () => {
        const status = await invoke('engine:status');
        return { ...status, available: false, error: message };
      },
      diagnostics: () => invoke('engine:diagnostics'),
      probe: (path: string) => invoke('engine:probe', path),
      probeAudio: (path: string) => invoke('engine:probe-audio', path),
      gpuMemory: () => invoke('engine:gpu-memory'),
      bindFrameSink: () => false,
      unbindFrameSink: () => {},
      frameInfo: () => ({ frame: null, painted: 0 }),
      inspectFrameSink: () => ({ error: message }),
      player: {
        open: unavailable,
        close: unavailable,
        warm: unavailable,
        play: unavailable,
        pause: unavailable,
        setRate: unavailable,
        seek: unavailable,
        tick: unavailable,
        setEffects: unavailable,
        stats: unavailable,
      },
      export: {
        start: (input: string, options: Record<string, unknown>) =>
          invoke('engine:export:start', input, options),
        progress: () => invoke('engine:export:progress'),
        cancel: () => invoke('engine:export:cancel'),
      },
    } as unknown as typeof EngineBridge;
  }
}

const engineBridge = loadEngineBridge();
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
  headlessExport: {
    log: (message: string) => electron.ipcRenderer.send('headless-export:log', message),
    complete: (result: { ok: boolean; outputPath?: string; error?: string }) =>
      electron.ipcRenderer.send('headless-export:complete', result),
  },
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

  // A phone's camera, over the local network
  phoneCamera: {
    /** Start serving the pairing page. Idempotent: returns the running session. */
    start: (): Promise<{ url: string; urls: string[]; port: number }> =>
      electron.ipcRenderer.invoke('phone-camera:start'),
    stop: (): Promise<void> => electron.ipcRenderer.invoke('phone-camera:stop'),
    /** Null when nothing is paired. Poll it while the panel is open. */
    state: (): Promise<{
      url: string;
      urls: string[];
      port: number;
      live: boolean;
      framesReceived: number;
      framesDropped: number;
      width: number;
      height: number;
      lastError?: string;
    } | null> => electron.ipcRenderer.invoke('phone-camera:state'),
    /** The newest JPEG from the phone, for showing its picture on the desktop. */
    frame: (): Promise<ArrayBuffer | null> => electron.ipcRenderer.invoke('phone-camera:frame'),
  },

  // Recording
  recorder: {
    getSources: (): Promise<DesktopSource[]> => electron.ipcRenderer.invoke('recorder:get-sources'),

    /** Microphones as the native recorder sees them, for when it is capturing. */
    listAudioCaptureDevices: (): Promise<
      Array<{ id: string; label: string; isDefault: boolean }>
    > => electron.ipcRenderer.invoke('recorder:list-audio-capture-devices'),

    /** Webcams as the native recorder sees them. */
    listWebcamDevices: (): Promise<Array<{ id: string; label: string; isDefault: boolean }>> =>
      electron.ipcRenderer.invoke('recorder:list-webcam-devices'),

    /** Open/release the native setup-preview owner. Recording takes ownership at start. */
    startWebcamPreview: (deviceId?: string): Promise<{ success: boolean; error?: string }> =>
      electron.ipcRenderer.invoke('recorder:start-webcam-preview', deviceId),
    stopWebcamPreview: (): Promise<void> =>
      electron.ipcRenderer.invoke('recorder:stop-webcam-preview'),
    /** Latest small JPEG from the native setup or recording camera owner. */
    webcamPreviewFrame: (): Promise<{
      jpeg: ArrayBuffer;
      width: number;
      height: number;
      sequence: number;
    } | null> => electron.ipcRenderer.invoke('recorder:webcam-preview-frame'),

    start: (config: RecordingConfig): Promise<StartRecordingResult> =>
      electron.ipcRenderer.invoke('recorder:start', config),

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

    /** Store the canvas padding (fraction of the canvas per side) on the project */
    updateCanvasPadding: (padding: number): Promise<number | null> =>
      electron.ipcRenderer.invoke('editor:update-canvas-padding', padding),

    /** Update project duration */
    updateProjectDuration: (durationMs: number) =>
      electron.ipcRenderer.invoke('editor:update-project-duration', durationMs),

    projectExists: (recordingDir: string): Promise<boolean> =>
      electron.ipcRenderer.invoke('editor:project-exists', recordingDir),

    /** Timeline thumbnail sheets by source. Usually empty right after open. */
    getSpritesheets: () => electron.ipcRenderer.invoke('editor:get-spritesheets'),

    /** Fires when a sheet finishes generating. Returns an unsubscribe. */
    onSpritesheetsUpdated: (callback: (sheets: unknown) => void) =>
      createSubscription('editor:spritesheets-updated', callback),

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
    fileSize: (filePath: string): Promise<number> =>
      electron.ipcRenderer.invoke('exporter:file-size', filePath),

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

  // GPU video engine. Optional: check `engine.status().available` first.
  engine: engineBridge,
});

// Helper to create a subscription that returns an unsubscribe function
function createSubscription<T>(channel: string, callback: (data: T) => void) {
  const handler = (_event: IpcRendererEvent, data: T) => callback(data);
  electron.ipcRenderer.on(channel, handler);
  // Return unsubscribe function
  return () => electron.ipcRenderer.removeListener(channel, handler);
}
