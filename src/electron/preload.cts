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
});

// Helper to create a subscription that returns an unsubscribe function
function createSubscription<T>(channel: string, callback: (data: T) => void) {
  const handler = (_event: IpcRendererEvent, data: T) => callback(data);
  electron.ipcRenderer.on(channel, handler);
  // Return unsubscribe function
  return () => electron.ipcRenderer.removeListener(channel, handler);
}
