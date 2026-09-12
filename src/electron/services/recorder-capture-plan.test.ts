import { describe, expect, it } from 'vitest';

import { nativeWebcamStartProblem } from './recorder-capture-plan.js';

describe('nativeWebcamStartProblem', () => {
  it('keeps a requested local webcam failure actionable instead of dropping the track', () => {
    const problem = nativeWebcamStartProblem(
      new Error(
        'start_monitor_recording_v2 failed to start webcam: webcam stream produced no valid frame: Hardware MFT lacked resources',
      ),
      false,
    );

    expect(problem).toContain('The webcam would not start');
    expect(problem).toContain('Close any other app using the camera');
  });

  it('identifies phone webcam failures without suggesting a local device change', () => {
    const problem = nativeWebcamStartProblem(
      new Error('start_monitor_recording_v2 failed to start webcam: phone stopped sending'),
      true,
    );

    expect(problem).toContain('The phone camera would not start');
    expect(problem).not.toContain('select the webcam');
  });

  it('leaves unrelated native capture errors to the general start policy', () => {
    expect(
      nativeWebcamStartProblem(new Error('desktop capture permission denied'), false),
    ).toBeNull();
  });
});
