import { describe, expect, it } from 'vitest';

import {
  mp4HasMovieBox,
  nativeWebcamStartProblem,
  planNativeAudio,
} from './recorder-capture-plan.js';

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

describe('mp4HasMovieBox', () => {
  function box(type: string, payload: number, largeSize = false): Uint8Array {
    const headerLength = largeSize ? 16 : 8;
    const bytes = new Uint8Array(headerLength + payload);
    const view = new DataView(bytes.buffer);
    if (largeSize) {
      view.setUint32(0, 1);
      view.setBigUint64(8, BigInt(bytes.length));
    } else {
      view.setUint32(0, bytes.length);
    }
    for (let i = 0; i < 4; i++) bytes[4 + i] = type.charCodeAt(i);
    return bytes;
  }

  function file(
    ...boxes: Uint8Array[]
  ): [(offset: number, length: number) => Uint8Array | null, number] {
    const total = boxes.reduce((sum, b) => sum + b.length, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const b of boxes) {
      bytes.set(b, at);
      at += b.length;
    }
    const readAt = (offset: number, length: number) =>
      offset >= total ? null : bytes.subarray(offset, Math.min(total, offset + length));
    return [readAt, total];
  }

  it('finds the movie box a finished recording ends with', () => {
    expect(mp4HasMovieBox(...file(box('ftyp', 16), box('mdat', 4096), box('moov', 64)))).toBe(true);
  });

  it('says no while the samples are written but the movie box is not', () => {
    expect(mp4HasMovieBox(...file(box('ftyp', 16), box('mdat', 4096)))).toBe(false);
  });

  it('follows a 64-bit mdat size to the box after it', () => {
    expect(mp4HasMovieBox(...file(box('ftyp', 16), box('mdat', 4096, true), box('moov', 64)))).toBe(
      true,
    );
  });

  it('finds a fast-start movie box ahead of the samples', () => {
    expect(mp4HasMovieBox(...file(box('ftyp', 16), box('moov', 64), box('mdat', 4096)))).toBe(true);
  });

  it('stops at a malformed box size instead of looping', () => {
    const [readAt, size] = file(box('ftyp', 16), box('mdat', 64));
    const bytes = readAt(24, 8);
    if (bytes) new DataView(bytes.buffer, bytes.byteOffset).setUint32(0, 4);
    expect(mp4HasMovieBox(readAt, size)).toBe(false);
  });

  it('says no for an empty file', () => {
    expect(mp4HasMovieBox(() => null, 0)).toBe(false);
  });
});

describe('planNativeAudio', () => {
  it('captures natively on Windows and Linux', () => {
    for (const platform of ['win32', 'linux']) {
      expect(planNativeAudio({ platform, recordSystemAudio: true, recordMic: true })).toEqual({
        systemAudio: true,
        microphone: true,
      });
    }
  });

  it('captures nothing natively where the addon has no audio backend', () => {
    expect(
      planNativeAudio({ platform: 'darwin', recordSystemAudio: true, recordMic: true }),
    ).toEqual({ systemAudio: false, microphone: false });
  });

  it('only captures what was asked for', () => {
    expect(
      planNativeAudio({ platform: 'linux', recordSystemAudio: false, recordMic: true }),
    ).toEqual({
      systemAudio: false,
      microphone: true,
    });
  });
});
