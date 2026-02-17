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
  'diagonal-lines': {
    id: 'diagonal-lines',
    label: 'Lines',
    style: {
      backgroundImage: `
        repeating-linear-gradient(45deg, rgba(255, 0, 100, 0.1) 0, rgba(255, 0, 100, 0.1) 1px, transparent 1px, transparent 20px),
        repeating-linear-gradient(-45deg, rgba(255, 0, 100, 0.1) 0, rgba(255, 0, 100, 0.1) 1px, transparent 1px, transparent 20px)
      `,
      backgroundSize: '40px 40px',
    },
    containerStyle: {
      backgroundColor: '#fafafa',
      color: '#111827',
    },
  },
  dots: {
    id: 'dots',
    label: 'Dots',
    style: {
      backgroundImage: 'radial-gradient(rgba(255, 255, 255, 0.2) 1px, transparent 1px)',
      backgroundSize: '20px 20px',
    },
    containerStyle: {
      backgroundColor: '#222',
    },
  },
  grid: {
    id: 'grid',
    label: 'Grid',
    style: {
      backgroundImage: `
        linear-gradient(rgba(255, 255, 255, 0.1) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.1) 1px, transparent 1px)
      `,
      backgroundSize: '30px 30px',
    },
    containerStyle: {
      backgroundColor: '#333',
    },
  },
  checks: {
    id: 'checks',
    label: 'Checks',
    style: {
      backgroundImage: `
        repeating-linear-gradient(45deg, rgba(0, 0, 0, 0.1) 25%, transparent 25%, transparent 75%, rgba(0, 0, 0, 0.1) 75%, rgba(0, 0, 0, 0.1)),
        repeating-linear-gradient(45deg, rgba(0, 0, 0, 0.1) 25%, transparent 25%, transparent 75%, rgba(0, 0, 0, 0.1) 75%, rgba(0, 0, 0, 0.1))
      `,
      backgroundPosition: '0 0, 10px 10px',
      backgroundSize: '20px 20px',
    },
    containerStyle: {
      backgroundColor: '#e5e5f7',
    },
  },
  triangles: {
    id: 'triangles',
    label: 'Triangles',
    style: {
      backgroundImage: `
        linear-gradient(45deg, rgba(0, 0, 0, 0.1) 25%, transparent 25%, transparent 75%, rgba(0, 0, 0, 0.1) 75%, rgba(0, 0, 0, 0.1)),
        linear-gradient(-45deg, rgba(0, 0, 0, 0.1) 25%, transparent 25%, transparent 75%, rgba(0, 0, 0, 0.1) 75%, rgba(0, 0, 0, 0.1))
      `,
      backgroundSize: '40px 40px',
    },
    containerStyle: {
      backgroundColor: '#f0f0f0',
    },
  },
  zigzag: {
    id: 'zigzag',
    label: 'Zigzag',
    style: {
      background: `
        linear-gradient(135deg, rgba(255,255,255,0.1) 25%, transparent 25%) -10px 0,
        linear-gradient(225deg, rgba(255,255,255,0.1) 25%, transparent 25%) -10px 0,
        linear-gradient(315deg, rgba(255,255,255,0.1) 25%, transparent 25%),
        linear-gradient(45deg, rgba(255,255,255,0.1) 25%, transparent 25%)
        `,
      backgroundSize: '20px 20px',
      backgroundColor: '#2a2a2a',
    },
    containerStyle: {},
  },
  waves: {
    id: 'waves',
    label: 'Waves',
    style: {
      background: `
        radial-gradient(circle at 100% 50%, transparent 20%, rgba(255,255,255,0.1) 21%, rgba(255,255,255,0.1) 34%, transparent 35%, transparent),
        radial-gradient(circle at 0% 50%, transparent 20%, rgba(255,255,255,0.1) 21%, rgba(255,255,255,0.1) 34%, transparent 35%, transparent) 0 -50px
        `,
      backgroundSize: '30px 100px',
      backgroundColor: '#3b3b3b',
    },
    containerStyle: {},
  },
  cross: {
    id: 'cross',
    label: 'Cross',
    style: {
      background: `
        radial-gradient(circle, transparent 20%, #222 20%, #222 80%, transparent 80%, transparent),
        radial-gradient(circle, transparent 20%, #222 20%, #222 80%, transparent 80%, transparent) 25px 25px,
        linear-gradient(#444 2px, transparent 2px) 0 -1px,
        linear-gradient(90deg, #444 2px, transparent 2px) -1px 0
        `,
      backgroundSize: '50px 50px, 50px 50px, 25px 25px, 25px 25px',
      backgroundColor: '#222',
    },
    containerStyle: {},
  },
};
