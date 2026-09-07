import { beforeEach, describe, expect, it } from 'vitest';

import { usePlaybackStore } from './playback-store';

const DURATION = 10_000;

/** A store parked mid-recording and playing, which is where most cases start. */
function playingAt(currentTime: number) {
  usePlaybackStore.setState({ duration: DURATION, currentTime, isPlaying: true });
  return usePlaybackStore.getState();
}

beforeEach(() => {
  usePlaybackStore.getState().reset();
});

/**
 * The transport used to have two ways to end and neither of them worked from
 * the native engine, which drove the playhead with a raw `setState` and so
 * skipped both the clamp and the stop. Playback ran forever with the playhead
 * pinned past the end of the timeline.
 */
describe('seeking', () => {
  it.each([DURATION + 1, DURATION + 34, DURATION * 2, Number.MAX_SAFE_INTEGER])(
    'clamps %d to the end of the timeline',
    (target) => {
      playingAt(0).seek(target);

      expect(usePlaybackStore.getState().currentTime).toBe(DURATION);
    },
  );

  it('clamps a negative seek to the start', () => {
    playingAt(5_000).seek(-500);

    expect(usePlaybackStore.getState().currentTime).toBe(0);
  });

  it('treats an unknown duration as unbounded', () => {
    // Duration is 0 until the media loads, and seeking has to still work then.
    usePlaybackStore.setState({ duration: 0, currentTime: 0 });
    usePlaybackStore.getState().seek(5_000);

    expect(usePlaybackStore.getState().currentTime).toBe(5_000);
  });
});

describe('reaching the end', () => {
  it('stops and rewinds when a delta tick runs past the end', () => {
    playingAt(DURATION - 100).tick(200);

    expect(usePlaybackStore.getState()).toMatchObject({ isPlaying: false, currentTime: 0 });
  });

  it('stops and rewinds when an absolute tick lands on the end', () => {
    // The `<video>` element reports absolute time; the engine reports its own.
    playingAt(DURATION - 100).tick(DURATION, 'absolute');

    expect(usePlaybackStore.getState()).toMatchObject({ isPlaying: false, currentTime: 0 });
  });

  it('stops and rewinds when the engine reports it finished', () => {
    // The native player stops its own clock at EOF; `finish` is how that
    // reaches the store, and it has to land exactly where ticking does.
    playingAt(DURATION).finish();

    expect(usePlaybackStore.getState()).toMatchObject({ isPlaying: false, currentTime: 0 });
  });

  it('leaves ordinary mid-recording ticks alone', () => {
    playingAt(1_000).tick(500);

    expect(usePlaybackStore.getState()).toMatchObject({ isPlaying: true, currentTime: 1_500 });
  });
});

describe('playing again afterwards', () => {
  it('starts from the top after finishing', () => {
    playingAt(DURATION).finish();
    usePlaybackStore.getState().play();

    expect(usePlaybackStore.getState()).toMatchObject({ isPlaying: true, currentTime: 0 });
  });

  it('restarts from a hand-scrubbed end', () => {
    // Nothing calls `finish` on this path -- the user dragged the playhead to
    // the end themselves -- so `play` has to notice on its own.
    usePlaybackStore.setState({ duration: DURATION, currentTime: DURATION, isPlaying: false });
    usePlaybackStore.getState().play();

    expect(usePlaybackStore.getState()).toMatchObject({ isPlaying: true, currentTime: 0 });
  });

  it('resumes in place from the middle', () => {
    usePlaybackStore.setState({ duration: DURATION, currentTime: 4_200, isPlaying: false });
    usePlaybackStore.getState().play();

    expect(usePlaybackStore.getState()).toMatchObject({ isPlaying: true, currentTime: 4_200 });
  });
});

describe('pausing', () => {
  it('stops without moving the playhead', () => {
    playingAt(4_200).pause();

    expect(usePlaybackStore.getState()).toMatchObject({ isPlaying: false, currentTime: 4_200 });
  });
});
