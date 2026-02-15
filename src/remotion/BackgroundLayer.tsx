import React from 'react';
import { Img } from 'remotion';

import type { RemotionInputProps } from './types';

/**
 * BackgroundLayer: Renders the canvas background.
 *
 * Supports:
 * - Solid color (backgroundColor)
 * - Image (backgroundPath) using Remotion's frame-safe <Img>
 */
export const BackgroundLayer: React.FC<RemotionInputProps> = React.memo(
  ({ backgroundPath, backgroundColor, canvasWidth, canvasHeight }) => {
    if (backgroundPath) {
      return (
        <Img
          src={backgroundPath}
          style={{
            width: canvasWidth,
            height: canvasHeight,
            objectFit: 'cover',
          }}
        />
      );
    }

    return (
      <div
        style={{
          width: canvasWidth,
          height: canvasHeight,
          backgroundColor: backgroundColor || '#1a1a2e',
        }}
      />
    );
  },
);
