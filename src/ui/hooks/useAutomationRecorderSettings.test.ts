import { describe, expect, it } from 'vitest';

import { uiSettingsFromAutomation } from './useAutomationRecorderSettings';

describe('uiSettingsFromAutomation', () => {
  it('maps the API keys onto the recorder screen', () => {
    expect(
      uiSettingsFromAutomation({
        'recording.outputDir': '/home/me/Videos/Recso',
        'recording.systemAudio': false,
        'recording.mic': true,
        'recording.micDeviceId': '67',
        'recording.camera': true,
        'recording.cameraDeviceId': '/dev/video0',
        'export.preset': '1080p-high',
      }),
    ).toEqual({
      outputDir: '/home/me/Videos/Recso',
      recordSystemAudio: false,
      recordMic: true,
      nativeMicDeviceId: '67',
      recordCamera: true,
      cameraDeviceId: '/dev/video0',
    });
  });

  it('keeps the screen\'s own device when the API says "default"', () => {
    expect(
      uiSettingsFromAutomation({ 'recording.micDeviceId': null, 'recording.cameraDeviceId': null }),
    ).toEqual({});
  });

  it('ignores values of the wrong type', () => {
    expect(
      uiSettingsFromAutomation({ 'recording.mic': 'yes', 'recording.outputDir': true }),
    ).toEqual({});
  });
});
