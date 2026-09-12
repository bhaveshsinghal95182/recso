/**
 * How the recording and the camera sit on the canvas out of the box.
 *
 * The shadow stacks are two layers each, which is the shape of every drop
 * shadow that reads as depth rather than as a smudge: a wide, faint one for the
 * ambient light, and a tight, darker one for the contact where the object meets
 * what it sits on. One layer alone gives you either a halo or a hard edge.
 *
 * Offsets are straight down. A horizontal offset implies a light source off to
 * one side, which is a stronger claim than a screen recording wants to make --
 * and it looks wrong the moment the recording is anchored to that same side.
 */

export const DEFAULT_VIDEO_STYLE = {
  borderRadius: 24,
  /**
   * No border.
   *
   * There used to be an 8px white one at 20% here, and it read as a frame drawn
   * around the picture rather than as the picture lifted off the canvas. The
   * shadow below does the same job -- separating the recording from whatever is
   * behind it -- without outlining it.
   *
   * Kept rather than deleted because it is still plumbed all the way through
   * both compositors and the engine, and a project that sets one still gets it.
   */
  borderWidth: 0,
  borderColor: 'rgba(255, 255, 255, 0.2)',
  shadows: [
    { offsetX: 0, offsetY: 18, blur: 45, color: 'rgba(0, 0, 0, 0.22)' },
    { offsetX: 0, offsetY: 4, blur: 10, color: 'rgba(0, 0, 0, 0.16)' },
  ],
};

export const DEFAULT_WEBCAM_STYLE = {
  anchor: 'bottom-right' as const,
  shape: 'rectangle-portrait' as const,
  aspectRatio: 3 / 4,
  heightRatio: 0.34,
  marginPx: 24,
  borderRadius: 24,
  borderWidth: 0,
  borderColor: 'rgba(255, 255, 255, 0.42)',
  opacity: 1,
  /**
   * Tighter and darker than the recording's, because the camera is a smaller
   * object sitting closer to the canvas -- the same shadow at the same spread
   * would make a thumbnail look like it was floating a metre off the page.
   */
  shadows: [
    { offsetX: 0, offsetY: 10, blur: 26, color: 'rgba(0, 0, 0, 0.28)' },
    { offsetX: 0, offsetY: 2, blur: 6, color: 'rgba(0, 0, 0, 0.20)' },
  ],
};

export const DEFAULT_ZOOM_EPSILON = 0.001;
export const MAX_BACKGROUND_SNAPSHOT_SCALE = 2;
export const MAX_BACKGROUND_SNAPSHOT_PIXELS = 12_000_000;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clampNormalised(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, value));
}
