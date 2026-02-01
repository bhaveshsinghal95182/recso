const electron = require('electron');
import type { IpcRendererEvent } from 'electron';
import type { Statistics, StaticData } from './services/stats.service';
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

  // Statistics
  stats: {
    subscribe: (callback: (stats: Statistics) => void) =>
      createSubscription('statistics', callback),
    getStatic: (): Promise<StaticData> => electron.ipcRenderer.invoke('get-static-data'),
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
