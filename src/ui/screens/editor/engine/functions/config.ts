import type { CompositionConfig } from '../types';
import { DEFAULT_BACKGROUND_COLOR } from './common';

export const defaultConfig: CompositionConfig = {
  background: {
    enabled: true,
    type: 'color',
    color: DEFAULT_BACKGROUND_COLOR,
  },
  video: {
    scale: 0.85,
    borderRadius: 24,
    border: {
      width: 0,
      color: '#ffffff',
    },
  },
  zooms: [],
  zoomRegions: [],
  cuts: [],
};
