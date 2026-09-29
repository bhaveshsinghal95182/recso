import { describe, expect, it, vi } from 'vitest';

import { type PreviewAudio, syncPreviewAudio } from './audio-sync';

function player(currentTime = 10, paused = false): PreviewAudio {
  return {
    currentTime,
    paused,
    seeking: false,
    readyState: 4,
    playbackRate: 1,
    pause: vi.fn(),
    play: vi.fn(async () => {}),
  };
}

describe('preview speech synchronization', () => {
  it('corrects a perceptible 150ms lag instead of accepting it', () => {
    const audio = player();
    syncPreviewAudio(audio, 10.15, true);
    expect(audio.currentTime).toBe(10.15);
  });
  it('aligns exactly before resuming even inside the drift tolerance', () => {
    const audio = player(10, true);
    syncPreviewAudio(audio, 10.04, true);
    expect(audio.currentTime).toBe(10.04);
    expect(audio.play).toHaveBeenCalledOnce();
  });
  it('corrects small lead and lag gently and restores normal speed', () => {
    const audio = player();
    syncPreviewAudio(audio, 10.05, true);
    expect(audio.playbackRate).toBeGreaterThan(1);
    expect(audio.currentTime).toBe(10);
    syncPreviewAudio(audio, 9.95, true);
    expect(audio.playbackRate).toBeLessThan(1);
    syncPreviewAudio(audio, 10.005, true);
    expect(audio.playbackRate).toBe(1);
  });
  it('aligns a paused seek and resets catch-up speed', () => {
    const audio = player();
    audio.playbackRate = 1.03;
    syncPreviewAudio(audio, 25, false);
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.currentTime).toBe(25);
    expect(audio.playbackRate).toBe(1);
  });
  it('does not restart an unfinished seek on each tick', () => {
    const audio = player();
    audio.seeking = true;
    syncPreviewAudio(audio, 30, true);
    expect(audio.currentTime).toBe(10);
    expect(audio.play).not.toHaveBeenCalled();
  });
  it('jumps over a cut instead of playing the removed speech', () => {
    const audio = player();
    syncPreviewAudio(audio, 15, true);
    expect(audio.currentTime).toBe(15);
    expect(audio.playbackRate).toBe(1);
  });

  it('leaves a stalled element alone until it moves again', () => {
    const audio = player();
    audio.readyState = 2;
    syncPreviewAudio(audio, 10.5, true, 0);
    expect(audio.currentTime).toBe(10);
  });
  it('does not seek again while the last seek settles', () => {
    const audio = player();
    syncPreviewAudio(audio, 10.15, true, 0);
    expect(audio.currentTime).toBe(10.15);
    audio.currentTime = 10.15;
    syncPreviewAudio(audio, 10.3, true, 100);
    expect(audio.currentTime).toBe(10.15);
    expect(audio.playbackRate).toBeGreaterThan(1);
  });
  it('learns how long a seek stalls and stops seeking in a loop', () => {
    // Every seek freezes the element for 90ms while the clock runs on: more
    // than the seek threshold, which once meant a seek every tick.
    const STALL_S = 0.09;
    const audio = player(0);
    let clockS = 0;
    let resumeAtS = 0;
    let seeks = 0;
    let time = 0;
    Object.defineProperty(audio, 'currentTime', {
      get: () => time,
      set: (value: number) => {
        seeks++;
        time = value;
        resumeAtS = clockS + STALL_S;
      },
    });
    syncPreviewAudio(audio, 0.2, true, 0); // a jump, as after a cut
    for (let tick = 1; tick <= 300; tick++) {
      const stepS = 1 / 60;
      clockS += stepS;
      if (clockS > resumeAtS) time += stepS * audio.playbackRate;
      syncPreviewAudio(audio, 0.2 + clockS, true, clockS * 1000);
    }
    expect(seeks).toBeLessThanOrEqual(3);
    expect(Math.abs(0.2 + clockS - time)).toBeLessThan(0.03);
  });
});
