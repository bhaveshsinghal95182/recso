import React from 'react';
import { AbsoluteFill } from 'remotion';

import { BackgroundLayer } from './BackgroundLayer';
import type { RemotionInputProps } from './types';
import { VideoLayer } from './VideoLayer';
import { ZoomEffect } from './ZoomEffect';

/**
 * MainComposition: Orchestrates all rendering layers.
 *
 * Rendering order (bottom to top):
 * 1. Background (solid color or image)
 * 2. Video (with zoom effect applied)
 * 3. (Future) Cursor animations
 * 4. (Future) Text overlays
 *
 * Each layer is independent and can be developed/tested separately.
 */
export const MainComposition: React.FC<RemotionInputProps> = React.memo((props) => {
  return (
    <AbsoluteFill>
      {/* Layer 1: Background fills entire canvas */}
      <BackgroundLayer {...props} />

      {/* Layer 2: Video with zoom animation */}
      <ZoomEffect {...props}>
        <VideoLayer {...props} />
      </ZoomEffect>

      {/* Future layers (cursor, text overlays) go here */}
    </AbsoluteFill>
  );
});
