import type React from 'react';

export interface BackgroundPatternConfig {
  id: string; // Keep ID for UI keys/selection
  label: string;
  style: React.CSSProperties;
  containerStyle?: React.CSSProperties;
}

export const patternPresets: Record<string, BackgroundPatternConfig> = {
  none: {
    id: 'none',
    label: 'None',
    style: {},
    containerStyle: {},
  },
  'gradient-blobs': {
    id: 'gradient-blobs',
    label: 'Blobs',
    style: {
      background: `
        radial-gradient(ellipse 80% 60% at 70% 20%, rgba(175, 109, 255, 0.85), transparent 68%),
        radial-gradient(ellipse 70% 60% at 20% 80%, rgba(255, 100, 180, 0.75), transparent 68%),
        radial-gradient(ellipse 60% 50% at 60% 65%, rgba(255, 235, 170, 0.98), transparent 68%),
        radial-gradient(ellipse 65% 40% at 50% 60%, rgba(120, 190, 255, 0.3), transparent 68%),
        linear-gradient(180deg, #f7eaff 0%, #fde2ea 100%)
      `,
    },
    containerStyle: {},
  },
  'orange-glow': {
    id: 'orange-glow',
    label: 'Orange Glow',
    style: {
      background: `
        radial-gradient(circle at 50% 100%, rgba(255, 69, 0, 0.6) 0%, transparent 60%),
        radial-gradient(circle at 50% 100%, rgba(255, 140, 0, 0.4) 0%, transparent 70%),
        radial-gradient(circle at 50% 100%, rgba(255, 215, 0, 0.3) 0%, transparent 80%)
      `,
    },
    containerStyle: {
      backgroundColor: '#000000',
    },
  },
  'crimson-depth': {
    id: 'crimson-depth',
    label: 'Crimson Depth',
    style: {
      background: 'radial-gradient(125% 125% at 50% 10%, #000000 40%, #2b0707 100%)',
    },
  },
};
