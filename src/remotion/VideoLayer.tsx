import React, { useMemo } from 'react';
import { OffthreadVideo } from 'remotion';
import { Sequence, staticFile, useVideoConfig } from 'remotion';

import { getUncutSegments } from './cut-utils';
import type { RemotionInputProps } from './types';

/**
 * VideoLayer: Renders the source video, frame-skipping cut regions.
 *
 * When cuts are present, it renders a <Sequence> per uncut segment,
 * using OffthreadVideo's trimBefore/trimAfter to select the exact
 * source range. Remotion never renders frames inside cut regions.
 *
 * When no cuts are present, it renders a single full-length <OffthreadVideo>.
 */
export const VideoLayer: React.FC<RemotionInputProps> = React.memo(
  ({ videoSrc, layout, cuts, sourceDurationMs, canvasWidth, canvasHeight }) => {
    const { fps } = useVideoConfig();

    // If videoSrc is a URL (http/file) use as is, otherwise treat as static file
    const src =
      videoSrc.startsWith('http') || videoSrc.startsWith('file:') ? videoSrc : staticFile(videoSrc);

    // Pre-compute uncut segments
    const segments = useMemo(
      () => getUncutSegments(cuts, sourceDurationMs || 0),
      [cuts, sourceDurationMs],
    );

    const hasCuts = cuts && cuts.length > 0 && sourceDurationMs;

    // --- Higher-resolution rendering strategy ---
    // Instead of sizing the video element to the layout dimensions (which
    // rasterises the video at ~85% of canvas → blurry when zoomed), we
    // render the <OffthreadVideo> at CANVAS size and CSS-transform it to
    // fit the layout area.
    //
    // Why canvas size and not native source resolution?
    // Remotion's compositor can't handle video elements larger than the
    // composition canvas — it leads to "No frame found" errors.
    // Canvas size (e.g. 1920×1080) is safe and already ~38% more pixel
    // data than layout size (~1632×918 at 85% fill).

    // The border/decoration wrapper sits at the layout position/size
    // so borders, shadows, and rounded corners align with the visible area.
    const decorationStyle: React.CSSProperties = {
      position: 'absolute',
      left: layout.x,
      top: layout.y,
      width: layout.width,
      height: layout.height,
      // Glassmorphic border container
      backgroundColor: 'rgba(255, 255, 255, 0.1)',
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
      border: '8px solid rgba(255, 255, 255, 0.2)',
      borderRadius: 24,
      boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.05)',
      boxSizing: 'border-box' as const,
      overflow: 'hidden',
    };

    // The inner container holds the video at CANVAS resolution and
    // CSS-transforms it to fit the layout area (inside the border).
    const borderWidth = 8;
    const innerWidth = layout.width - borderWidth * 2;
    const innerHeight = layout.height - borderWidth * 2;

    // Use canvas dimensions as the video render size (capped, safe for compositor)
    const renderWidth = canvasWidth || innerWidth;
    const renderHeight = canvasHeight || innerHeight;

    // Scale from canvas resolution down to the inner display area
    const scaleX = innerWidth / renderWidth;
    const scaleY = innerHeight / renderHeight;
    const uniformScale = Math.min(scaleX, scaleY);

    const videoContainerStyle: React.CSSProperties = {
      width: renderWidth,
      height: renderHeight,
      transformOrigin: '0 0',
      transform: `scale(${uniformScale})`,
      borderRadius: 16 / uniformScale, // compensate so visual radius matches
      overflow: 'hidden',
    };

    const videoStyle: React.CSSProperties = {
      width: renderWidth,
      height: renderHeight,
      objectFit: 'cover',
    };

    // No cuts — render a single video
    if (!hasCuts) {
      return (
        <div style={decorationStyle}>
          <div style={videoContainerStyle}>
            <OffthreadVideo src={src} style={videoStyle} />
          </div>
        </div>
      );
    }

    // With cuts — render a <Sequence> per uncut segment
    // Each segment uses trimBefore/trimAfter to select the exact source range
    return (
      <div style={decorationStyle}>
        <div style={videoContainerStyle}>
          {segments.map((seg, i) => {
            // Convert ms to frames
            const durationInFrames = Math.round((seg.durationMs / 1000) * fps);
            const compositionFromFrame = Math.round((seg.compositionStartMs / 1000) * fps);
            const trimBeforeFrame = Math.round((seg.sourceStartMs / 1000) * fps);
            const trimAfterFrame = Math.round((seg.sourceEndMs / 1000) * fps);

            return (
              <Sequence key={i} from={compositionFromFrame} durationInFrames={durationInFrames}>
                <OffthreadVideo
                  src={src}
                  trimBefore={trimBeforeFrame}
                  trimAfter={trimAfterFrame}
                  style={videoStyle}
                />
              </Sequence>
            );
          })}
        </div>
      </div>
    );
  },
);
