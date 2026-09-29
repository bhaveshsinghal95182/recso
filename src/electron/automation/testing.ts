/**
 * A fake `AutomationServices` for the Automation API's own tests.
 */

import { ExportJobs } from './export-jobs.js';
import type { AutomationServices } from './services.js';
import { defaultSettings, SettingsStore } from './settings-store.js';

export function fakeServices(overrides: Partial<AutomationServices> = {}): AutomationServices {
  return {
    platform: 'linux',
    appVersion: '9.9.9',
    transportPath: '/run/user/1000/recso/api.sock',
    settings: new SettingsStore(defaultSettings('/home/me/Videos')),
    engineAvailable: () => true,
    videoEncoders: () => ['nvenc', 'openh264'],
    recordingState: () => ({ state: 'idle', recordingId: null, durationMs: 0, bytesWritten: 0 }),
    editorProject: () => null,
    showWindow: () => undefined,
    listDevices: async () => ({
      microphones: [{ id: 'mic-1', label: 'Built-in mic', isDefault: true }],
      cameras: [],
      sources: [{ id: 'screen:0', name: 'Screen', kind: 'portal', isPrimary: true }],
      rememberedSource: false,
    }),
    startRecording: async () => ({
      recordingId: 'rec-1',
      sourceId: 'screen:0',
      videoPath: '/home/me/Videos/rec/rec.mp4',
    }),
    stopRecording: async () => ({
      recordingId: 'rec-1',
      projectDir: '/home/me/Videos/rec',
      videoPath: '/home/me/Videos/rec/rec.mp4',
      cameraPath: null,
      durationMs: 5000,
      clicks: 0,
    }),
    forgetSource: () => false,
    recentProjectDirs: () => [],
    openProject: () => undefined,
    exports: new ExportJobs({
      spawn: () => {
        throw new Error('fakeServices: pass exports to run an export');
      },
    }),
    exportSpawnPlan: (request) => ({
      command: '/opt/recso/recso',
      args: ['--export-project', request.projectDir, '--export-output', request.output],
      env: {},
    }),
    pathExists: () => false,
    ensureDir: () => undefined,
    ...overrides,
  };
}
