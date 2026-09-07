import { create } from 'zustand';

import type { FrameState } from '../types';

interface PlaybackState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  frameState: FrameState | null;

  // Actions
  play: () => void;
  pause: () => void;
  /** Playback ran to the end of the timeline. */
  finish: () => void;
  seek: (timeMs: number) => void;
  setDuration: (duration: number) => void;
  tick: (deltaOrTimeMs: number, mode?: 'delta' | 'absolute') => void;
  setFrameState: (state: FrameState | null) => void;

  // Reset
  reset: () => void;
}

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  frameState: null,

  play: () => {
    const { currentTime, duration } = get();
    if (duration > 0 && currentTime >= duration) {
      set({ currentTime: 0, isPlaying: true });
    } else {
      set({ isPlaying: true });
    }
  },

  pause: () => set({ isPlaying: false }),

  /**
   * Stop and rewind.
   *
   * Parking the playhead at the far right left the transport in a state with
   * nowhere to go: the only thing pressing play could do was jump back to the
   * start anyway. Doing it here means the timeline shows where the next play
   * will actually begin, and every clock -- the `<video>` element or the native
   * engine -- resolves the same way.
   */
  finish: () => set({ currentTime: 0, isPlaying: false }),

  seek: (timeMs) => {
    const { duration } = get();
    // If duration is unknown (0), treat it as unbounded for seeking.
    const upperBound = duration > 0 ? duration : Number.POSITIVE_INFINITY;
    const newTime = Math.max(0, Math.min(timeMs, upperBound));
    set({ currentTime: newTime });
  },

  setDuration: (duration) => set({ duration }),

  tick: (deltaOrTimeMs, mode = 'delta') => {
    set((state) => {
      let nextTime: number;
      if (mode === 'absolute') {
        nextTime = deltaOrTimeMs;
      } else {
        nextTime = state.currentTime + deltaOrTimeMs;
      }

      if (state.duration > 0 && nextTime >= state.duration) {
        return { currentTime: 0, isPlaying: false };
      }
      return { currentTime: Math.max(0, nextTime) };
    });
  },

  setFrameState: (frameState) => set({ frameState }),

  reset: () =>
    set({
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      frameState: null,
    }),
}));
