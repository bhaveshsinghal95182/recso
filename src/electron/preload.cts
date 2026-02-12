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

    updateZoomConfig: (config: Record<string, unknown>) =>
      electron.ipcRenderer.invoke('editor:update-zoom-config', config),

    /** Update project duration */
    updateProjectDuration: (durationMs: number) =>
      electron.ipcRenderer.invoke('editor:update-project-duration', durationMs),

    /** Update background color */
    updateBackgroundColor: (color: string) =>
      electron.ipcRenderer.invoke('editor:update-background-color', color),

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
    addCut: (cut: { id: string; startMs: number; endMs: number }) =>
      electron.ipcRenderer.invoke('editor:add-cut', cut),

    /** Remove a cut region by ID */
    removeCut: (cutId: string) => electron.ipcRenderer.invoke('editor:remove-cut', cutId),

    /** Update a cut region */
    updateCut: (cut: { id: string; startMs: number; endMs: number }) =>
      electron.ipcRenderer.invoke('editor:update-cut', cut),

    /** Get all zoom regions */
    getZoomRegions: () => electron.ipcRenderer.invoke('editor:get-zoom-regions'),

    /** Add a new zoom region */
    addZoomRegion: (zoom: {
      id: string;
      startMs: number;
      endMs: number;
      zoomLevel: number;
      focalX: number;
      focalY: number;
      easeDurationMs: number;
    }) => electron.ipcRenderer.invoke('editor:add-zoom-region', zoom),

    /** Remove a zoom region by ID */
    removeZoomRegion: (zoomId: string) =>
      electron.ipcRenderer.invoke('editor:remove-zoom-region', zoomId),

    /** Update a zoom region */
    updateZoomRegion: (zoom: {
      id: string;
      startMs: number;
      endMs: number;
      zoomLevel: number;
      focalX: number;
      focalY: number;
      easeDurationMs: number;
    }) => electron.ipcRenderer.invoke('editor:update-zoom-region', zoom),

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
      }[],
    ) => electron.ipcRenderer.invoke('editor:update-zoom-regions', zooms),

    /** Get mouse events for the active project's recording */
    getMouseEvents: (): Promise<
      {
        id: number;
        recordingId: string;
        timestampMs: number;
        x: number;
        y: number;
        eventType: 'click' | 'mousemove';
        button?: 'left' | 'right' | 'middle';
      }[]
    > => electron.ipcRenderer.invoke('editor:get-mouse-events'),
  },

  // Exporter
  exporter: {
    /** Start export with configuration */
    start: (config: Record<string, unknown>) =>
      electron.ipcRenderer.invoke('exporter:start', config),

    /** Cancel ongoing export */
    cancel: (): Promise<boolean> => electron.ipcRenderer.invoke('exporter:cancel'),

    /** Get current progress */
    getProgress: () => electron.ipcRenderer.invoke('exporter:get-progress'),

    /** Get current export state */
    getState: (): Promise<string> => electron.ipcRenderer.invoke('exporter:get-state'),

    /** Get current job info */
    getJob: () => electron.ipcRenderer.invoke('exporter:get-job'),

    /** Get exports folder path */
    getExportsFolder: (): Promise<string | null> =>
      electron.ipcRenderer.invoke('exporter:get-exports-folder'),

    /** Open exports folder in file explorer */
    openExportsFolder: (): Promise<boolean> =>
      electron.ipcRenderer.invoke('exporter:open-exports-folder'),

    /** Show file in folder */
    showInFolder: (filePath: string): Promise<boolean> =>
      electron.ipcRenderer.invoke('exporter:show-in-folder', filePath),

    /** Subscribe to progress updates */
    onProgress: (callback: (progress: Record<string, unknown>) => void) => {
      electron.ipcRenderer.send('exporter:subscribe-progress');
      const handler = (_event: IpcRendererEvent, progress: Record<string, unknown>) =>
        callback(progress);
      electron.ipcRenderer.on('exporter:progress', handler);
      // Return unsubscribe function
      return () => {
        electron.ipcRenderer.send('exporter:unsubscribe-progress');
        electron.ipcRenderer.removeListener('exporter:progress', handler);
      };
    },
  },

  // Debug tools
  debug: {
    getMouseStatus: () => electron.ipcRenderer.invoke('debug:get-mouse-status'),
  },
});

// Helper to create a subscription that returns an unsubscribe function
function createSubscription<T>(channel: string, callback: (data: T) => void) {
  const handler = (_event: IpcRendererEvent, data: T) => callback(data);
  electron.ipcRenderer.on(channel, handler);
  // Return unsubscribe function
  return () => electron.ipcRenderer.removeListener(channel, handler);
}
