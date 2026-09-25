/** Keep the audio element on the native player's source timeline. */
export interface PreviewAudio {
  currentTime: number;
  playbackRate: number;
  paused: boolean;
  seeking: boolean;
  pause(): void;
  play(): Promise<void>;
}

export function syncPreviewAudio(
  audio: PreviewAudio,
  targetSeconds: number,
  playing: boolean,
): void {
  if (!Number.isFinite(targetSeconds) || targetSeconds < 0) return;

  const drift = targetSeconds - audio.currentTime;
  if (!playing) {
    audio.pause();
    audio.playbackRate = 1;
    if (!audio.seeking && Math.abs(drift) > 0.02) audio.currentTime = targetSeconds;
    return;
  }

  // A seek is asynchronous. Do not restart it on every presentation tick.
  if (audio.seeking) return;
  if (audio.paused) {
    audio.currentTime = targetSeconds;
    audio.playbackRate = 1;
    void audio.play().catch(() => {});
    return;
  }

  if (Math.abs(drift) > 0.08) {
    // Seeks and cuts need an immediate correction, not a long catch-up.
    audio.currentTime = targetSeconds;
    audio.playbackRate = 1;
  } else {
    // Correct small differences without repeatedly seeking through speech.
    audio.playbackRate =
      Math.abs(drift) <= 0.02 ? 1 : Math.max(0.97, Math.min(1.03, 1 + drift * 0.5));
  }
}
