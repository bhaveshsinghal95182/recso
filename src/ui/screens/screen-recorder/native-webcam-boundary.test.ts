import { describe, expect, it } from 'vitest';

import recorderIpc from '../../../electron/ipc/recorder.ipc.ts?raw';
import preload from '../../../electron/preload.cts?raw';
import recorderService from '../../../electron/services/recorder.service.ts?raw';
import cameraPreview from './camera-preview.tsx?raw';
import capturePreviewStage from './capture-preview-stage.tsx?raw';
import screenRecorder from './screen-recorder.tsx?raw';

describe('native webcam ownership', () => {
  it('does not open or enumerate local webcams through browser media APIs', () => {
    const rendererCaptureSources = [cameraPreview, capturePreviewStage, screenRecorder];

    for (const rendererSource of rendererCaptureSources) {
      expect(rendererSource).not.toMatch(/navigator\.mediaDevices|getUserMedia|enumerateDevices/);
    }
  });

  it('does not silently retry recording without the requested native webcam', () => {
    expect(recorderService).not.toContain('falling back to renderer camera sidecar');
  });

  it('draws local preview frames supplied by the native webcam owner', () => {
    expect(cameraPreview).toContain('window.electron.recorder.webcamPreviewFrame');
    expect(cameraPreview).toContain('<canvas');
    expect(screenRecorder).toMatch(/window\.electron\.recorder\s*\.startWebcamPreview/);
    expect(screenRecorder).toContain('window.electron.recorder.stopWebcamPreview');
    expect(recorderIpc).toContain('recorder:webcam-preview-frame');
    expect(preload).toContain('recorder:webcam-preview-frame');
  });
});
