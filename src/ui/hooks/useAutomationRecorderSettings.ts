/**
 * The recorder UI's link to the Automation API's recorder settings.
 *
 * While the API is off this does nothing: main answers `{ active: false }`
 * and never pushes, so the recorder keeps its own defaults as before. While
 * it's on, the recorder adopts the API's values on mount and whenever an API
 * client changes them, and writes the user's own changes back so the next
 * `recording.start` records what the screen shows.
 */

import { useCallback, useEffect, useRef } from 'react';

import type { AutomationRecorderSettings } from '@/electron';

/** The recorder UI's settings the API shares, in the UI's own terms. */
export interface RecorderUiSettings {
  outputDir: string;
  recordSystemAudio: boolean;
  recordMic: boolean;
  nativeMicDeviceId: string;
  recordCamera: boolean;
  cameraDeviceId: string;
}

const KEYS: Record<keyof RecorderUiSettings, string> = {
  outputDir: 'recording.outputDir',
  recordSystemAudio: 'recording.systemAudio',
  recordMic: 'recording.mic',
  nativeMicDeviceId: 'recording.micDeviceId',
  recordCamera: 'recording.camera',
  cameraDeviceId: 'recording.cameraDeviceId',
};

/**
 * The API's values as UI settings. A device id of null means "the default
 * device", which the UI already picked, so it's left out rather than cleared.
 */
export function uiSettingsFromAutomation(
  values: Record<string, string | boolean | null>,
): Partial<RecorderUiSettings> {
  const result: Partial<RecorderUiSettings> = {};
  for (const [field, key] of Object.entries(KEYS) as [keyof RecorderUiSettings, string][]) {
    const value = values[key];
    if (typeof value === 'string' && value.length > 0) {
      if (field === 'outputDir' || field === 'nativeMicDeviceId' || field === 'cameraDeviceId') {
        result[field] = value;
      }
    } else if (typeof value === 'boolean') {
      if (field === 'recordSystemAudio' || field === 'recordMic' || field === 'recordCamera') {
        result[field] = value;
      }
    }
  }
  return result;
}

export function useAutomationRecorderSettings(
  apply: (settings: Partial<RecorderUiSettings>) => void,
) {
  const activeRef = useRef(false);
  const applyRef = useRef(apply);

  useEffect(() => {
    applyRef.current = apply;
  }, [apply]);

  useEffect(() => {
    const bridge = window.electron.automation;
    if (!bridge) return;

    let cancelled = false;
    const adopt = (settings: AutomationRecorderSettings) => {
      activeRef.current = settings.active;
      if (!cancelled && settings.active) {
        applyRef.current(uiSettingsFromAutomation(settings.values));
      }
    };

    const unsubscribe = bridge.onRecorderSettings(adopt);
    void bridge.getRecorderSettings().then(adopt, () => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  /** Report one of the user's own changes; a no-op while the API is off. */
  return useCallback(
    <K extends keyof RecorderUiSettings>(field: K, value: RecorderUiSettings[K]) => {
      if (!activeRef.current) return;
      void window.electron.automation
        .setRecorderSettings({ [KEYS[field]]: value === '' ? null : value })
        .catch(() => undefined);
    },
    [],
  );
}
