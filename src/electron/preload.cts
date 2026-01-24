const electron = require('electron');
import type { IpcRendererEvent } from 'electron';
import type { Statistics, StaticData } from './services/stats.service';

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
});

// Helper to create a subscription that returns an unsubscribe function
function createSubscription<T>(channel: string, callback: (data: T) => void) {
  const handler = (_event: IpcRendererEvent, data: T) => callback(data);
  electron.ipcRenderer.on(channel, handler);
  // Return unsubscribe function
  return () => electron.ipcRenderer.removeListener(channel, handler);
}
