/**
 * Where a timestamp sits along the timeline, as a percentage of its width.
 *
 * Clamped, and that is the whole point. The playhead is positioned straight off
 * this, so a `currentTime` past the duration used to place it outside the track
 * entirely -- which is exactly what a clock reading slightly long (the native
 * engine's, clamped to the decoder's duration rather than the project's) made
 * happen. Whatever disagreement upstream, the playhead stays on the ruler.
 */
export function timeToPercent(timeMs: number, durationMs: number): number {
  if (!(durationMs > 0) || !Number.isFinite(timeMs)) {
    return 0;
  }

  return Math.max(0, Math.min(100, (timeMs / durationMs) * 100));
}
