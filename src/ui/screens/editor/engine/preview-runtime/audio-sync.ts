/** Keep the audio element on the native player's source timeline. */
export interface PreviewAudio {
  currentTime: number;
  playbackRate: number;
  paused: boolean;
  seeking: boolean;
  /** `HTMLMediaElement.readyState`: below HAVE_FUTURE_DATA the time is not moving. */
  readyState: number;
  pause(): void;
  play(): Promise<void>;
}

const HAVE_FUTURE_DATA = 3;

/** Drift that a seek corrects; below it, playback speed does. */
const SEEK_DRIFT_S = 0.08;

/** How long a seek's landing is left alone before it can be judged. */
const SETTLE_MS = 500;

/** A seek lands this much later than asked at most; more is a real jump. */
const MAX_LEAD_S = 0.3;

/**
 * What a playing element's last seek taught us.
 *
 * A seek during playback is not instant: the element stops, re-buffers from
 * the new position, then resumes, while the engine clock keeps running. On
 * Linux that stall is about 90 ms -- longer than `SEEK_DRIFT_S` -- so every
 * corrective seek landed far enough behind to trigger the next one, ten times
 * a second, and speech crackled. Seeking ahead by the stall the previous
 * correction showed lands the audio on time instead.
 */
interface SeekState {
  settleUntilMs: number;
  lastSeekMs: number;
  leadS: number;
}

const seekStates = new WeakMap<PreviewAudio, SeekState>();

function seekState(audio: PreviewAudio): SeekState {
  let state = seekStates.get(audio);
  if (!state) {
    state = { settleUntilMs: 0, lastSeekMs: Number.NEGATIVE_INFINITY, leadS: 0 };
    seekStates.set(audio, state);
  }
  return state;
}

export function syncPreviewAudio(
  audio: PreviewAudio,
  targetSeconds: number,
  playing: boolean,
  nowMs: number = performance.now(),
): void {
  if (!Number.isFinite(targetSeconds) || targetSeconds < 0) return;

  const state = seekState(audio);
  const drift = targetSeconds - audio.currentTime;
  if (!playing) {
    audio.pause();
    audio.playbackRate = 1;
    state.settleUntilMs = 0;
    if (!audio.seeking && Math.abs(drift) > 0.02) audio.currentTime = targetSeconds;
    return;
  }

  // A seek is asynchronous, and so is the re-buffering after it. Do not pile
  // corrections onto an element that has not started moving again.
  if (audio.seeking) return;
  if (audio.paused) {
    audio.currentTime = targetSeconds + state.leadS;
    audio.playbackRate = 1;
    state.settleUntilMs = nowMs + SETTLE_MS;
    state.lastSeekMs = nowMs;
    void audio.play().catch(() => {});
    return;
  }
  if (audio.readyState < HAVE_FUTURE_DATA) return;

  if (Math.abs(drift) > SEEK_DRIFT_S && nowMs >= state.settleUntilMs) {
    // Still behind right after a correction: that is the seek's own stall,
    // and the next seek should lead by it. A big drift is a cut or a user
    // seek, which says nothing about the stall.
    if (nowMs - state.lastSeekMs < SETTLE_MS * 3 && Math.abs(drift) <= MAX_LEAD_S) {
      state.leadS = Math.max(0, Math.min(MAX_LEAD_S, state.leadS + drift));
    }
    // Seeks and cuts need an immediate correction, not a long catch-up.
    audio.currentTime = targetSeconds + state.leadS;
    audio.playbackRate = 1;
    state.settleUntilMs = nowMs + SETTLE_MS;
    state.lastSeekMs = nowMs;
    return;
  }

  // Correct small differences without repeatedly seeking through speech.
  audio.playbackRate =
    Math.abs(drift) <= 0.02 ? 1 : Math.max(0.97, Math.min(1.03, 1 + drift * 0.5));
}
