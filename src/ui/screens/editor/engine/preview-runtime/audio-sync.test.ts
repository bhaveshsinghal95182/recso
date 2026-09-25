import { describe, expect, it, vi } from 'vitest';

import { type PreviewAudio, syncPreviewAudio } from './audio-sync';

function player(currentTime = 10, paused = false): PreviewAudio {
  return {
    currentTime,
    paused,
    seeking: false,
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
});
