/**
 * `AutomationServices` over recso's real services -- the same ones the IPC
 * handlers call.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { app, type BrowserWindow } from 'electron';

import * as editorService from '../services/editor.service.js';
import { getEngineBindings } from '../services/engine/native.js';
import { getRecentProjects } from '../services/recent-projects.service.js';
import * as RecorderService from '../services/recorder.service.js';
import { readStoredRestoreToken, writeStoredRestoreToken } from './enabled.js';
import { ExportJobs, type ExportJobStatus, exportSpawnPlan } from './export-jobs.js';
import type { PendingNavigation } from './navigation.js';
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
  /** Sends the window to the recorder or the editor. */
  navigation: PendingNavigation;
  /** Where export events go (the server's broadcast). */
  emit?: (event: string, payload: ExportJobStatus) => void;
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
      showWindow(options.getWindow());
      options.navigation.request({ screen: 'recorder' });
    },
    restoreToken: {
      read: () => readStoredRestoreToken(userData),
      write: (token) => writeStoredRestoreToken(userData, token),
    },
  });

  const exports = new ExportJobs({
    spawn: (plan) =>
      spawn(plan.command, plan.args, {
        env: plan.env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    onEvent: (event, status) => options.emit?.(event, status),
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
    recentProjectDirs: (limit) => getRecentProjects(limit).map((row) => row.path),
    openProject: (projectDir) => {
      showWindow(options.getWindow());
      options.navigation.request({ screen: 'editor', projectDir });
    },
    exports,
    exportSpawnPlan: (request) =>
      exportSpawnPlan({
        execPath: process.execPath,
        packaged: app.isPackaged,
        appPath: app.getAppPath(),
        env: process.env,
        ...request,
      }),
    pathExists: (candidate) => fs.existsSync(candidate),
    ensureDir: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
    },
    ...recording,
  };
}
