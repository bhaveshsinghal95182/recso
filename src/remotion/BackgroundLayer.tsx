import React from 'react';
import { Img } from 'remotion';

import type { BackgroundPattern, RemotionInputProps } from './types';

interface PatternConfig {
  style: React.CSSProperties;
  containerStyle?: React.CSSProperties;
}

const patterns: Record<BackgroundPattern, PatternConfig> = {
  none: {
    style: {},
    containerStyle: {},
  },
  'gradient-blobs': {
    style: {
      background: `
        radial-gradient(ellipse 80% 60% at 70% 20%, rgba(175, 109, 255, 0.85), transparent 68%),
        radial-gradient(ellipse 70% 60% at 20% 80%, rgba(255, 100, 180, 0.75), transparent 68%),
        radial-gradient(ellipse 60% 50% at 60% 65%, rgba(255, 235, 170, 0.98), transparent 68%),
        radial-gradient(ellipse 65% 40% at 50% 60%, rgba(120, 190, 255, 0.3), transparent 68%),
        linear-gradient(180deg, #f7eaff 0%, #fde2ea 100%)
      `,
    },
    containerStyle: {}, // Start with transparent/none so gradients show
  },
  'diagonal-lines': {
    style: {
      backgroundImage: `
        repeating-linear-gradient(45deg, rgba(255, 0, 100, 0.1) 0, rgba(255, 0, 100, 0.1) 1px, transparent 1px, transparent 20px),
        repeating-linear-gradient(-45deg, rgba(255, 0, 100, 0.1) 0, rgba(255, 0, 100, 0.1) 1px, transparent 1px, transparent 20px)
      `,
      backgroundSize: '40px 40px',
    },
    containerStyle: {
      backgroundColor: '#fafafa',
      color: '#111827', // text-gray-900
    },
  },
};

/**
 * BackgroundLayer: Renders the canvas background.
 *
 * Supports:
 * - Solid color (backgroundColor)
 * - Image (backgroundPath) using Remotion's frame-safe <Img>
 * - CSS Patterns (backgroundPattern) with modular configuration
 */
export const BackgroundLayer: React.FC<RemotionInputProps> = React.memo(
  ({ backgroundPath, backgroundColor, backgroundPattern = 'none', canvasWidth, canvasHeight }) => {
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

    const patternConfig = patterns[backgroundPattern] || patterns.none;

    // Merge container styles:
    // 1. defaults from the pattern config
    // 2. explicit override from props.backgroundColor (if provided and different from default)
    // Note: If props.backgroundColor is passed, it takes precedence over pattern defaults.
    const mergedContainerStyle = {
      ...patternConfig.containerStyle,
      ...(backgroundColor ? { backgroundColor } : {}),
      width: canvasWidth,
      height: canvasHeight,
      position: 'relative' as const,
      overflow: 'hidden',
    };

    // If no pattern and no specific color, fallback to dark default
    if (backgroundPattern === 'none' && !mergedContainerStyle.backgroundColor && !backgroundColor) {
      mergedContainerStyle.backgroundColor = '#1a1a2e';
    }

    return (
      <div style={mergedContainerStyle}>
        {backgroundPattern !== 'none' && (
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
