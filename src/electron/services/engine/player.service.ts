import type { WebFrameMain } from 'electron';

import type {
  OpenedVideo,
  PlayerStats,
  VideoInfo,
  VideoPlayerInstance,
} from '../../types/engine.types.js';
import type { RecordingMediaInfo } from '../../types/recorder.types.js';
import { requireEngineBindings } from './native.js';
import { normalizeMediaPath } from './paths.js';
import { clearHandleCache, sendTextureToFrame } from './shared-texture.service.js';

/**
 * One player at a time. It owns a decode thread and an 18-texture pool (~149MB
 * of BGRA at 1080p), so leaking these is expensive -- always close the old one
 * before opening the next.
 */
let player: VideoPlayerInstance | null = null;

/**
 * Open a file in the engine.
 *
 * `known` is what the recorder reported when it wrote the file. Passing it
 * means nothing has to be re-derived, and -- more usefully -- the two sources
 * get compared, so a file that is not what the recorder thinks it is says so
 * at open rather than behaving strangely later.
 */
export function openPlayer(path: string, known?: RecordingMediaInfo | null): OpenedVideo {
  closePlayer();

  const { VideoPlayer } = requireEngineBindings();
  player = new VideoPlayer(normalizeMediaPath(path));

  return reconcile(player.info(), known);
}

/**
 * How far the recorder's duration may sit from the container's before it means
 * something is actually wrong.
 *
 * Generous on purpose. The two measure different edges -- the recorder times
 * first-frame-to-stop on the wall clock, the container runs sample zero to the
 * end of the last sample -- and each end carries slop the other cannot see:
 * capture startup latency, the encoder's timeline base, the tail sample's
 * assigned duration. Measured across runs the gap ranged +658ms to -518ms with
 * no relationship to frame rate.
 *
 * So this is not a precision check. It is here to catch a recording paired with
 * the wrong file, or one truncated by a crash -- cases where the gap is a
 * multiple of this, not a fraction.
 */
const DURATION_TOLERANCE_MS = 1500;

function reconcile(container: VideoInfo, known?: RecordingMediaInfo | null): OpenedVideo {
  if (!known?.usable) {
    return {
      width: container.width,
      height: container.height,
      codedWidth: container.codedWidth,
      codedHeight: container.codedHeight,
      duration: container.duration,
      fps: container.fps,
      source: 'container',
      container,
      disagreements: [],
    };
  }

  const disagreements: string[] = [];

  if (known.width !== container.width || known.height !== container.height) {
    disagreements.push(
      `geometry: recorder ${known.width}x${known.height}, container ${container.width}x${container.height}`,
    );
  }

  const durationDriftMs = Math.abs(known.durationMs - container.duration);

  if (durationDriftMs > DURATION_TOLERANCE_MS) {
    disagreements.push(
      `duration: recorder ${known.durationMs.toFixed(0)}ms, container ${container.duration.toFixed(0)}ms ` +
        `(drift ${durationDriftMs.toFixed(0)}ms)`,
    );
  }

  return {
    // Geometry comes from the container: it is what the decoder will actually
    // hand back, and a disagreement is reported above rather than resolved by
    // preferring a number the textures will not match.
    width: container.width,
    height: container.height,
    codedWidth: container.codedWidth,
    codedHeight: container.codedHeight,
    // Duration follows the container, because that is what the decoder will
    // actually produce and what seeking is bounded by. The recorder's
    // wall-clock figure is kept alongside it as `captureDuration` rather than
    // replacing it -- claiming a longer timeline than the file contains would
    // just make the tail unreachable.
    duration: container.duration,
    captureDuration: known.durationMs,
    // Rate comes from the recorder, which counted frames. Here the container is
    // wrong by construction: it carries a nominal rate that variable-rate
    // capture never hits (60 reported against 1.7 measured on an idle desktop).
    fps: known.fps,
    source: 'recorder',
    frames: known.frames,
    hasAudio: known.hasAudio,
    codec: known.codec,
    container,
    disagreements,
  };
}

export function closePlayer(): void {
  player?.close();
  player = null;
  // The old pool's handles are gone; caching them would hand Electron a stale
  // NT handle on the next open.
  clearHandleCache();
}

export function requirePlayer(): VideoPlayerInstance {
  if (!player) {
    throw new Error('no video open');
  }
  return player;
}

export function hasPlayer(): boolean {
  return player !== null;
}

/**
 * Push every pool texture through the full send-and-draw path once.
 *
 * Importing the handles in the main process costs ~1.6ms for the whole pool
 * and changes nothing. The real cost lands in the GPU process the first time a
 * shared texture is actually *drawn*, as one stall that otherwise falls inside
 * the first second of playback and drops a dozen frames. The renderer draws
 * these to a scratch canvas (see the 'warm' arg) so nothing flashes on screen.
 */
export async function warmPool(frame: WebFrameMain) {
  const active = requirePlayer();
  const started = performance.now();

  for (const texture of active.poolTextures()) {
    await sendTextureToFrame(frame, texture, 'warm');
  }

  return { warmMs: performance.now() - started };
}

/**
 * Ask the engine for the frame due now and, if there is one, hand its texture
 * to the renderer.
 *
 * `presented: false` is the normal case -- the display refreshes faster than
 * the video, so most ticks have nothing new to show.
 */
export async function presentTick(frame: WebFrameMain) {
  const active = requirePlayer();
  const due = active.tick();

  if (!due) {
    return { presented: false as const, ...summarise(active.stats()) };
  }

  const started = performance.now();
  await sendTextureToFrame(frame, due.texture);

  return {
    presented: true as const,
    pts: due.pts,
    sendMs: performance.now() - started,
    ...summarise(active.stats()),
  };
}

function summarise(stats: PlayerStats) {
  return {
    currentTime: stats.currentTime,
    playing: stats.playing,
    rate: stats.rate,
    queueDepth: stats.queueDepth,
    decoded: stats.decoded,
    dropped: stats.dropped,
    avgDecodeMs: stats.avgDecodeMs,
    lastSeekMs: stats.lastSeekMs,
    lastSeekDecoded: stats.lastSeekDecoded,
    endOfStream: stats.endOfStream,
  };
}
