/**
 * `AutomationServices` over recso's real services -- the same ones the IPC
 * handlers call.
 */

import path from 'node:path';

import { app, type BrowserWindow } from 'electron';

import * as editorService from '../services/editor.service.js';
import { getEngineBindings } from '../services/engine/native.js';
import * as RecorderService from '../services/recorder.service.js';
import { readStoredRestoreToken, writeStoredRestoreToken } from './enabled.js';
import { createRecordingControl } from './recording-control.js';
import type { AutomationServices, RecordingStateName } from './services.js';
import type { SettingsStore } from './settings-store.js';

interface EncoderListing {
  listVideoEncoders?: () => string[];
}

export interface ElectronServicesOptions {
  getWindow: () => BrowserWindow | null;
  transportPath: string;
  settings: SettingsStore;
}

function showWindow(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

export function createElectronServices(options: ElectronServicesOptions): AutomationServices {
  const userData = app.getPath('userData');
  const recording = createRecordingControl({
    platform: process.platform,
    settings: options.settings,
    showRecorder: () => {
      const window = options.getWindow();
      showWindow(window);
      if (window && !window.isDestroyed()) {
        window.webContents.send('automation:show-recorder');
      }
    },
    restoreToken: {
      read: () => readStoredRestoreToken(userData),
      write: (token) => writeStoredRestoreToken(userData, token),
    },
  });

  return {
    platform: process.platform,
    appVersion: app.getVersion(),
    transportPath: options.transportPath,
    settings: options.settings,
    engineAvailable: () => getEngineBindings() !== null,
    videoEncoders: () => {
      const bindings = getEngineBindings() as EncoderListing | null;
      try {
        return bindings?.listVideoEncoders?.() ?? [];
      } catch {
        return [];
      }
    },
    recordingState: () => {
      const state = RecorderService.getState();
      const name: RecordingStateName = RecorderService.isFinalizing()
        ? 'stopping'
        : (state.state.toLowerCase() as RecordingStateName);
      return {
        state: name,
        recordingId: state.recordingId,
        durationMs: state.duration,
        bytesWritten: state.bytesWritten,
      };
    },
    editorProject: () => {
      const project = editorService.getActiveProject();
      if (!project) return null;
      return { projectDir: path.dirname(project.projectFolderPath), name: project.name };
    },
    showWindow: () => showWindow(options.getWindow()),
    ...recording,
  };
}
