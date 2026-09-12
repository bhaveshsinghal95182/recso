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
    // Empty rather than the editor's default stack: this is the bare
    // composition a caller starts from, and the project's own style is layered
    // over it by the config builders.
    shadows: [],
  },
  zooms: [],
  zoomRegions: [],
  cuts: [],
  webcamCuts: [],
  layerStates: [
    { id: 'background', space: 'base' },
    { id: 'video', space: 'zoomed' },
    { id: 'cursor', space: 'zoomed' },
    { id: 'webcam', space: 'base' },
  ],
};
