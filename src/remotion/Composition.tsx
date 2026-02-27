import React from 'react';
import { AbsoluteFill } from 'remotion';

import { BackgroundLayer } from './BackgroundLayer';
import { CursorLayer } from './CursorLayer';
import type { RemotionInputProps } from './types';
import { VideoLayer } from './VideoLayer';
import { ZoomEffect } from './ZoomEffect';

/**
 * MainComposition: Orchestrates all rendering layers.
 *
 * Rendering order (bottom to top):
 * 1. Background (solid color or image)
 * 2. Video (with zoom effect applied)
 * 3. Cursor overlay (Velocity recordings only, inside zoom so it tracks)
 * 4. (Future) Text overlays
 *
 * Each layer is independent and can be developed/tested separately.
 */
export const MainComposition: React.FC<RemotionInputProps> = React.memo((props) => {
  return (
    <AbsoluteFill>
      {/* Layer 1: Background fills entire canvas */}
      <BackgroundLayer {...props} />

      {/* Layer 2: Video with zoom animation + Layer 3: Cursor (inside zoom to track) */}
      <ZoomEffect {...props}>
        <VideoLayer {...props} />

        {/* Layer 3: Cursor overlay (only for Velocity recordings with cursor data) */}
        {props.cursorFrames && props.cursorFrames.length > 0 && (
          <CursorLayer
            cursorFrames={props.cursorFrames}
            cursorSizeMultiplier={props.cursorSizeMultiplier}
          />
        )}
      </ZoomEffect>
    </AbsoluteFill>
  );
});
