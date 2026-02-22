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
  ({ videoSrc, layout, cuts, sourceDurationMs }) => {
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

    // Shared container style
    const containerStyle: React.CSSProperties = {
      position: 'absolute',
      left: layout.x,
      top: layout.y,
      width: layout.width,
      height: layout.height,
      // Glassmorphic border container
      padding: 12,
      backgroundColor: 'rgba(255, 255, 255, 0.1)',
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
      border: '8px solid rgba(255, 255, 255, 0.2)',
      borderRadius: 24,
      boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.05)',
      boxSizing: 'border-box' as const,
      overflow: 'hidden',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
    };

    const videoStyle: React.CSSProperties = {
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      borderRadius: 16,
    };

    // No cuts — render a single video
    if (!hasCuts) {
      return (
        <div style={containerStyle}>
          <OffthreadVideo src={src} style={videoStyle} />
        </div>
      );
    }

    // With cuts — render a <Sequence> per uncut segment
    // Each segment uses trimBefore/trimAfter to select the exact source range
    return (
      <div style={containerStyle}>
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
    );
  },
);
