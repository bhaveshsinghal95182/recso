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
  /** Webcam overlay rect in canvas coordinates, or null when the overlay is off. */
  webcamLayout: CompositionLayout | null;
  durationMs: number;
  compositionConfig: CompositionConfig;
  videoSrc: string;
  webcamSrc: string;
  backgroundImageSrc: string;
  backgroundContainerStyle: React.CSSProperties;
  selectedPattern: Project['backgroundPattern'];
  hasPattern: boolean;
  shouldRenderBackground: boolean;
}
