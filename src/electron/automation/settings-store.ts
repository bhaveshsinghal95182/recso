/**
 * The recorder and export settings the Automation API may read and change.
 *
 * Only this allowlist is reachable. The values live in memory for as long as
 * recso runs (see the Log in docs/automation-api.md): the recorder UI adopts
 * them while the API is on and writes its own changes back, so `settings.get`
 * always says what the next recording will use.
 */

import { EventEmitter } from 'node:events';

import type { JsonSchema } from './schema.js';

export const EXPORT_PRESETS = [
  '720p-low',
  '720p-medium',
  '720p-high',
  '720p-lossless',
  '1080p-low',
  '1080p-medium',
  '1080p-high',
  '1080p-lossless',
  '4k-low',
  '4k-medium',
  '4k-high',
  '4k-lossless',
] as const;
export type ExportPreset = (typeof EXPORT_PRESETS)[number];

export interface AutomationSettings {
  /** Where new recordings are written, one folder per recording. */
  'recording.outputDir': string;
  'recording.systemAudio': boolean;
  'recording.mic': boolean;
  /** A microphone id from `devices.list`; null is the system default. */
  'recording.micDeviceId': string | null;
  'recording.camera': boolean;
  /** A camera id from `devices.list`; null is the default camera. */
  'recording.cameraDeviceId': string | null;
  /** Where exports go when no output is given; null is the project's own `exports` folder. */
  'export.outputDir': string | null;
  'export.preset': ExportPreset;
}

export type SettingKey = keyof AutomationSettings;

const absolutePath = 'An absolute path.';

export const SETTING_SCHEMAS: Record<SettingKey, JsonSchema> = {
  'recording.outputDir': { type: 'string', minLength: 1, description: absolutePath },
  'recording.systemAudio': { type: 'boolean' },
  'recording.mic': { type: 'boolean' },
  'recording.micDeviceId': { type: ['string', 'null'] },
  'recording.camera': { type: 'boolean' },
  'recording.cameraDeviceId': { type: ['string', 'null'] },
  'export.outputDir': { type: ['string', 'null'], description: `${absolutePath} null resets it.` },
  'export.preset': { type: 'string', enum: EXPORT_PRESETS },
};

export const SETTING_KEYS = Object.keys(SETTING_SCHEMAS) as SettingKey[];

/** The defaults the recorder UI has always used. */
export function defaultSettings(videosDir: string): AutomationSettings {
  return {
    'recording.outputDir': videosDir,
    'recording.systemAudio': true,
    'recording.mic': false,
    'recording.micDeviceId': null,
    'recording.camera': false,
    'recording.cameraDeviceId': null,
    'export.outputDir': null,
    'export.preset': '1080p-high',
  };
}

export class SettingsStore {
  private values: AutomationSettings;
  private readonly events = new EventEmitter<{ changed: [Partial<AutomationSettings>] }>();

  constructor(defaults: AutomationSettings) {
    this.values = { ...defaults };
  }

  get(): AutomationSettings {
    return { ...this.values };
  }

  value<K extends SettingKey>(key: K): AutomationSettings[K] {
    return this.values[key];
  }

  /** Apply already-validated values; reports only the keys that really changed. */
  set(patch: Partial<AutomationSettings>): Partial<AutomationSettings> {
    const changed: Partial<AutomationSettings> = {};
    for (const key of Object.keys(patch) as SettingKey[]) {
      const next = patch[key];
      if (next === undefined || this.values[key] === next) continue;
      (changed as Record<string, unknown>)[key] = next;
    }
    if (Object.keys(changed).length > 0) {
      this.values = { ...this.values, ...changed };
      this.events.emit('changed', changed);
    }
    return changed;
  }

  onChange(listener: (changed: Partial<AutomationSettings>) => void): () => void {
    this.events.on('changed', listener);
    return () => this.events.off('changed', listener);
  }
}
