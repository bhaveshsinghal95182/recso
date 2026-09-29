/**
 * What the Automation API's methods need from the rest of recso.
 *
 * The methods only see this interface. `electron-services.ts` implements it
 * over the real services (the same ones the IPC handlers call); tests hand in
 * a fake, so every method's validation and shape is checked without Electron.
 */

import type { SettingsStore } from './settings-store.js';

export type RecordingStateName = 'idle' | 'recording' | 'paused' | 'stopping';

export interface RecordingStateSummary {
  state: RecordingStateName;
  recordingId: string | null;
  durationMs: number;
  bytesWritten: number;
}

export interface EditorProjectSummary {
  projectDir: string;
  name: string;
}

export interface CaptureDevice {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface CaptureSource {
  id: string;
  name: string;
  kind: 'screen' | 'window' | 'portal';
  isPrimary: boolean;
}

export interface DevicesListing {
  microphones: CaptureDevice[];
  cameras: CaptureDevice[];
  sources: CaptureSource[];
  /** Linux: whether a remembered portal source will be reused. Null where there is no portal. */
  rememberedSource: boolean | null;
}

/** `recording.start`'s params after validation; unset fields come from the settings. */
export interface RecordingStartRequest {
  sourceId?: string;
  outputDir?: string;
  fileName?: string;
  systemAudio?: boolean;
  mic?: boolean;
  micDeviceId?: string | null;
  camera?: boolean;
  cameraDeviceId?: string | null;
  rememberSource?: boolean;
}

export interface RecordingStarted {
  recordingId: string;
  sourceId: string;
  /** Where the video will be written, unless that folder is taken by the time it stops. */
  videoPath: string;
  /** Linux with `rememberSource`: true when the portal gave a token to reuse. */
  rememberedSource?: boolean;
}

export interface RecordingStopped {
  recordingId: string;
  projectDir: string;
  videoPath: string;
  cameraPath: string | null;
  durationMs: number;
  clicks: number;
}

export interface AutomationServices {
  readonly platform: NodeJS.Platform;
  readonly appVersion: string;
  /** Where the API is listening, for `app.status`. */
  readonly transportPath: string;
  readonly settings: SettingsStore;
  engineAvailable(): boolean;
  /** Video encoders an export can use, best first: `nvenc`, `openh264`, or Media Foundation's. */
  videoEncoders(): string[];
  recordingState(): RecordingStateSummary;
  /** The project open in the editor, if the editor is showing one. */
  editorProject(): EditorProjectSummary | null;
  /** Bring recso's window to the front, restoring it from the tray. */
  showWindow(): void;
  listDevices(): Promise<DevicesListing>;
  /** Throws `already_recording`, `source_unavailable` or `recording_failed`. */
  startRecording(request: RecordingStartRequest): Promise<RecordingStarted>;
  /** Waits for the file to be finalised. Throws `not_recording` or `recording_failed`. */
  stopRecording(): Promise<RecordingStopped>;
  /** Linux: drop the remembered portal source. False when there was none. */
  forgetSource(): boolean;
}
