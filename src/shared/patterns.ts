import type { CSSProperties } from 'react';

export interface BackgroundPatternConfig {
  id: string;
  label: string;
  style: CSSProperties;
  containerStyle?: CSSProperties;
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
  'prism-drift': {
    id: 'prism-drift',
    label: 'Prism Drift',
    style: {
      background: `
        conic-gradient(from 120deg at 50% 50%, rgba(255, 0, 130, 0.55), rgba(70, 110, 255, 0.55), rgba(80, 255, 190, 0.45), rgba(255, 190, 0, 0.55), rgba(255, 0, 130, 0.55)),
        radial-gradient(70% 80% at 20% 20%, rgba(255, 255, 255, 0.4), transparent 70%),
        linear-gradient(160deg, #1a1436 0%, #271a47 100%)
      `,
    },
  },
  'mint-eclipse': {
    id: 'mint-eclipse',
    label: 'Mint Eclipse',
    style: {
      background: `
        radial-gradient(circle at 25% 25%, rgba(162, 255, 211, 0.8), transparent 42%),
        radial-gradient(circle at 78% 72%, rgba(71, 189, 255, 0.72), transparent 48%),
        radial-gradient(circle at 60% 35%, rgba(35, 50, 90, 0.55), transparent 60%),
        linear-gradient(135deg, #0b1020 0%, #1a2938 100%)
      `,
    },
  },
  'paper-waves': {
    id: 'paper-waves',
    label: 'Paper Waves',
    style: {
      background: `
        radial-gradient(120% 55% at 10% 100%, rgba(255, 255, 255, 0.58), transparent 62%),
        radial-gradient(120% 55% at 90% 0%, rgba(255, 219, 176, 0.5), transparent 62%),
        repeating-linear-gradient(-20deg, rgba(0, 0, 0, 0.06) 0 6px, rgba(255, 255, 255, 0.12) 6px 12px),
        linear-gradient(145deg, #efe8d8 0%, #d8cfba 100%)
      `,
    },
  },
  'signal-grid': {
    id: 'signal-grid',
    label: 'Signal Grid',
    style: {
      background: `
        linear-gradient(rgba(255, 255, 255, 0.08) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.08) 1px, transparent 1px),
        radial-gradient(circle at 30% 20%, rgba(255, 90, 180, 0.3), transparent 45%),
        radial-gradient(circle at 75% 75%, rgba(64, 195, 255, 0.32), transparent 42%),
        linear-gradient(120deg, #0e0f1f 0%, #162745 100%)
      `,
      backgroundSize: '16px 16px, 16px 16px, auto, auto, auto',
    },
  },
  'sunset-arc': {
    id: 'sunset-arc',
    label: 'Sunset Arc',
    style: {
      background: `
        radial-gradient(110% 75% at 50% 115%, rgba(255, 100, 80, 0.6), transparent 62%),
        radial-gradient(90% 55% at 50% 115%, rgba(255, 186, 92, 0.65), transparent 58%),
        radial-gradient(70% 45% at 50% 115%, rgba(255, 236, 155, 0.72), transparent 56%),
        linear-gradient(180deg, #2b1d4f 0%, #6f274e 48%, #d15b4f 100%)
      `,
    },
  },
};
