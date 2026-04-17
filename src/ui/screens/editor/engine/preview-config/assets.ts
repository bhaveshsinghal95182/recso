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
}

export function getPreviewBackgroundPresentation(
  project: Project | null,
): PreviewBackgroundPresentation {
  const selectedPattern = project?.backgroundPattern ?? null;

  return {
    selectedPattern,
    hasPattern: selectedPattern !== null && selectedPattern.id !== 'none',
    backgroundContainerStyle: {
      backgroundColor: project?.backgroundColor || '#000000',
      ...(selectedPattern?.containerStyle || {}),
    },
  };
}
