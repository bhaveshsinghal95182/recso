import React from 'react';
import { useCurrentFrame } from 'remotion';

import type { PrecomputedCursorFrame } from './types';

/**
 * CursorLayer: Renders a mouse cursor overlay on top of the video.
 *
 * Ultra-lightweight component — all heavy math is precomputed.
 * Each frame does a single O(1) array lookup and applies the values.
 *
 * Uses GPU-accelerated `transform: translate()` instead of `top`/`left`
 * for buttery-smooth rendering during both playback and export.
 */
export const CursorLayer: React.FC<{
  cursorFrames: PrecomputedCursorFrame[];
  cursorSizeMultiplier?: number;
}> = React.memo(({ cursorFrames, cursorSizeMultiplier = 1.0 }) => {
  const frame = useCurrentFrame();

  // O(1) lookup — no searching, no filtering, no math
  const data = cursorFrames[frame];
  if (!data) return null;

  // Merge user's custom size with the precomputed blip scale
  const finalScale = data.scale * cursorSizeMultiplier;

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: 1,
        height: 1,
        // GPU-accelerated transform for position + scale
        // The cursor SVG has its tip at (0,0) so we don't need a hotspot offset
        transform: `translate(${data.x}px, ${data.y}px) scale(${finalScale})`,
        transformOrigin: '0 0',
        opacity: data.opacity,
        willChange: 'transform',
        pointerEvents: 'none',
        zIndex: 100,
        overflow: 'visible',
      }}
    >
      {/* Cursor SVG - macOS-style arrow, tip at (0,0) */}
      <CursorSVG />

      {/* Click ripple indicator */}
      {data.isClick && <ClickRipple scale={finalScale} />}
    </div>
  );
});

/**
 * macOS-style cursor arrow SVG.
 * The tip of the arrow is at coordinate (0, 0) for pixel-perfect positioning.
 * Rendered inline to avoid network requests during Remotion export.
 */
const CursorSVG: React.FC = React.memo(() => (
  <svg
    width="24"
    height="24"
    viewBox="-1 -1 20 26"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    style={{ display: 'block', overflow: 'visible' }}
  >
    {/* Shadow for visibility on any background */}
    <path
      d="M0 0L0 17.5L4 13.5L8 20L10.5 19L6.5 12L12 12L0 0Z"
      fill="rgba(0,0,0,0.3)"
      transform="translate(0.7, 0.7)"
    />
    {/* White cursor body */}
    <path d="M0 0L0 17.5L4 13.5L8 20L10.5 19L6.5 12L12 12L0 0Z" fill="white" />
    {/* Black outline */}
    <path
      d="M0 0L0 17.5L4 13.5L8 20L10.5 19L6.5 12L12 12L0 0Z"
      stroke="black"
      strokeWidth="1"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
));

/**
 * Click ripple: a ring that appears on click frames.
 * Purely visual — the sizing is handled by the parent's scale transform.
 */
const ClickRipple: React.FC<{ scale: number }> = React.memo(({ scale }) => {
  // Ripple grows as the blip recovers (scale goes from small → 1.0)
  // So we invert: when scale is small (just clicked), ripple is big
  const rippleSize = 32 + (1.0 - scale) * 24;
  const rippleOpacity = Math.max(0, 1.0 - scale) * 1.5; // Fade as blip recovers

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: rippleSize,
        height: rippleSize,
        borderRadius: '50%',
        border: '2px solid rgba(255, 255, 255, 0.8)',
        backgroundColor: 'rgba(255, 255, 255, 0.15)',
        transform: 'translate(-50%, -50%)',
        opacity: rippleOpacity,
        pointerEvents: 'none',
      }}
    />
  );
});
