import type React from 'react';

import type { Project } from '@/types';

import type { CompositionConfig, CompositionLayout } from '../types';

export type CanvasSize = {
  width: number;
  height: number;
};

export interface EnginePreviewMappedConfig {
  canvasSize: CanvasSize;
  layout: CompositionLayout;
  durationMs: number;
  compositionConfig: CompositionConfig;
  videoSrc: string;
  webcamSrc: string;
  backgroundImageSrc: string;
  backgroundContainerStyle: React.CSSProperties;
  selectedPattern: Project['backgroundPattern'];
  hasPattern: boolean;
}
