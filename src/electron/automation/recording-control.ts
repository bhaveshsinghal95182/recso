/**
 * Recording over the Automation API, through the recorder's own session
 * functions -- the same ones its button uses.
 */

import fs from 'node:fs';
import path from 'node:path';

import { startRecordingSession, stopRecordingSession } from '../ipc/recorder.ipc.js';
import * as editorService from '../services/editor.service.js';
import * as RecorderService from '../services/recorder.service.js';
import type { RecordingConfig } from '../types/recorder.types.js';
import { AutomationError } from './protocol.js';
import {
  defaultRecordingName,
  describeSource,
  pickSource,
  startFailureReason,
} from './recording-helpers.js';
import type {
  DevicesListing,
  RecordingStarted,
  RecordingStartRequest,
  RecordingStopped,
} from './services.js';
import type { SettingsStore } from './settings-store.js';

export interface RecordingControlOptions {
  platform: NodeJS.Platform;
  settings: SettingsStore;
  /** Bring the recorder screen to the front; called before capture starts. */
  showRecorder: () => void;
  restoreToken: { read(): string | null; write(token: string | null): void };
}

export function createRecordingControl(options: RecordingControlOptions) {
  const { platform, settings } = options;
  const portal = platform === 'linux';

  return {
    async listDevices(): Promise<DevicesListing> {
      const sources = await RecorderService.getSources();
      return {
        microphones: RecorderService.listNativeAudioCaptureDevices(),
        cameras: RecorderService.listNativeWebcamDevices(),
        sources: sources.map((source) => describeSource(source, platform)),
        rememberedSource: portal ? options.restoreToken.read() !== null : null,
      };
    },

    async startRecording(request: RecordingStartRequest): Promise<RecordingStarted> {
      if (RecorderService.getState().recordingId || RecorderService.isFinalizing()) {
        throw new AutomationError('already_recording', 'recso is already recording');
      }

      // Also refreshes the recorder's idea of which windows exist, which a
      // window id is resolved against.
      const source = pickSource(await RecorderService.getSources(), request.sourceId);
      const values = settings.get();
      const outputDir = request.outputDir ?? values['recording.outputDir'];
      const fileName = request.fileName ?? defaultRecordingName(new Date());
      const rememberSource = portal && request.rememberSource === true;
      const camera = request.camera ?? values['recording.camera'];

      const config: RecordingConfig = {
        sourceId: source.id,
        outputDir,
        fileName,
        fileExtension: 'mp4',
        recordSystemAudio: request.systemAudio ?? values['recording.systemAudio'],
        recordMic: request.mic ?? values['recording.mic'],
        nativeMicDeviceId:
          (request.micDeviceId !== undefined
            ? request.micDeviceId
            : values['recording.micDeviceId']) ?? undefined,
        recordCamera: camera,
        cameraDeviceId:
          (request.cameraDeviceId !== undefined
            ? request.cameraDeviceId
            : values['recording.cameraDeviceId']) ?? undefined,
        cameraSource: 'local',
        targetFps: 60,
        // The recorder UI's defaults.
        options: { videoBitrate: 5_000_000, audioBitrate: 0 },
        rememberSource,
        portalRestoreToken: rememberSource ? (options.restoreToken.read() ?? undefined) : undefined,
      };

      // Before capture starts: an API recording is never one the user can't see.
      options.showRecorder();

      const result = startRecordingSession(config);
      if (!result.success || !result.recordingId) {
        const message = result.error ?? 'the recording did not start';
        throw new AutomationError(startFailureReason(message), message);
      }

      if (rememberSource && result.portalRestoreToken) {
        options.restoreToken.write(result.portalRestoreToken);
      }

      return {
        recordingId: result.recordingId,
        sourceId: source.id,
        videoPath: path.join(outputDir, fileName, `${fileName}.mp4`),
        ...(rememberSource ? { rememberedSource: Boolean(result.portalRestoreToken) } : {}),
      };
    },

    async stopRecording(): Promise<RecordingStopped> {
      const { recordingId } = RecorderService.getState();
      if (!recordingId) {
        throw new AutomationError('not_recording', 'nothing is recording');
      }

      const { result, clicks } = await stopRecordingSession(recordingId);
      if (!result.success || !result.filePath) {
        throw new AutomationError('recording_failed', result.error ?? 'the recording failed');
      }

      const projectDir = await editorService.ensureProjectFile(recordingId);
      if (!projectDir) {
        throw new AutomationError(
          'recording_failed',
          `the recording was saved to ${result.filePath} but its project could not be written`,
        );
      }

      const cameraPath = RecorderService.inferNativeCameraSidecarPath(result.filePath);
      return {
        recordingId,
        projectDir,
        videoPath: result.filePath,
        cameraPath: fs.existsSync(cameraPath) ? cameraPath : null,
        durationMs: result.media?.durationMs ?? 0,
        clicks,
      };
    },

    forgetSource(): boolean {
      if (!portal || options.restoreToken.read() === null) return false;
      options.restoreToken.write(null);
      return true;
    },
  };
}
