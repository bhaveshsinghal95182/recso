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
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
