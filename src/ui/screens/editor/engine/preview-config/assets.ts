import type React from 'react';

import type { Project } from '@/types';

import { toFileUrl } from '../export-pipeline/source-paths';

export interface PreviewAssetSources {
  videoSrc: string;
  webcamSrc: string;
  backgroundImageSrc: string;
}

export function getPreviewAssetSources(
  project: Project | null,
  webcamSourcePath: string | undefined,
): PreviewAssetSources {
  return {
    videoSrc: toFileUrl(project?.rawVideoPath),
    webcamSrc: toFileUrl(webcamSourcePath),
    backgroundImageSrc: toFileUrl(project?.backgroundPath),
  };
}

export interface PreviewBackgroundPresentation {
  selectedPattern: Project['backgroundPattern'];
  hasPattern: boolean;
  backgroundContainerStyle: React.CSSProperties;
  shouldRenderBackground: boolean;
}

export function getPreviewBackgroundPresentation(
  project: Project | null,
): PreviewBackgroundPresentation {
  const selectedPattern = project?.backgroundPattern ?? null;
  const canvasBackgroundEnabled = project?.canvasBackgroundEnabled !== false;

  return {
    selectedPattern,
    hasPattern:
      canvasBackgroundEnabled && selectedPattern !== null && selectedPattern.id !== 'none',
    backgroundContainerStyle: canvasBackgroundEnabled
      ? {
          backgroundColor: project?.backgroundColor || '#000000',
          ...(selectedPattern?.containerStyle || {}),
        }
      : {},
    shouldRenderBackground: canvasBackgroundEnabled,
  };
}
