import React from 'react';
import { Img, staticFile } from 'remotion';

import type { RemotionInputProps } from './types.js';

/**
 * BackgroundLayer: Renders the canvas background.
 *
 * Supports:
 * - Solid color (backgroundColor)
 * - Image (backgroundPath) using Remotion's frame-safe <Img>
 * - CSS Patterns (backgroundPattern) with modular configuration
 */
export const BackgroundLayer: React.FC<RemotionInputProps> = React.memo(
  ({ backgroundPath, backgroundColor, backgroundPattern, canvasWidth, canvasHeight }) => {
    if (backgroundPath) {
      // If it's an absolute path from the project file, use file:// protocol.
      // If it's a relative path from the remotion renderer's linkVideoToBundle, use staticFile()
      const isAbsolute =
        backgroundPath.startsWith('file:') ||
        backgroundPath.includes(':/') ||
        backgroundPath.includes(':\\') ||
        backgroundPath.startsWith('/');

      const resolvedSrc = isAbsolute
        ? backgroundPath.startsWith('file:')
          ? backgroundPath
          : `file://${backgroundPath}`
        : staticFile(backgroundPath);

      return (
        <Img
          src={resolvedSrc}
          style={{
            width: canvasWidth,
            height: canvasHeight,
            objectFit: 'cover',
          }}
        />
      );
    }

    // Determine if we have a valid pattern object
    // For backward compatibility (during dev), handle string case if necessary,
    // though the type system now expects BackgroundPatternConfig.
    // Ideally, the prop is now the config object itself.
    let patternConfig = typeof backgroundPattern === 'object' ? backgroundPattern : null;
    const patternId = patternConfig ? patternConfig.id : 'none';

    // Merge container styles:
    // 1. defaults from the pattern config
    // 2. explicit override from props.backgroundColor (if provided and different from default)
    // Note: If props.backgroundColor is passed, it takes precedence over pattern defaults.
    const mergedContainerStyle = {
      ...(patternConfig?.containerStyle || {}),
      ...(backgroundColor ? { backgroundColor } : {}),
      width: canvasWidth,
      height: canvasHeight,
      position: 'relative' as const,
      overflow: 'hidden',
    };

    // If no pattern and no specific color, fallback to dark default
    if (patternId === 'none' && !mergedContainerStyle.backgroundColor && !backgroundColor) {
      mergedContainerStyle.backgroundColor = '#1a1a2e';
    }

    return (
      <div style={mergedContainerStyle}>
        {patternId !== 'none' && patternConfig && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 0,
              pointerEvents: 'none',
              ...patternConfig.style,
            }}
          />
        )}
      </div>
    );
  },
);
