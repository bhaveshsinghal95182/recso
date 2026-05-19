import type React from 'react';

import type { BackgroundMode, Project } from '@/types';

import { toFileUrl } from '../export-pipeline/source-paths';

function resolveBackgroundMode(project: Project | null): BackgroundMode {
  if (project?.backgroundMode === 'color') return 'color';
  if (project?.backgroundMode === 'pattern') return 'pattern';
  if (project?.backgroundMode === 'image') return 'image';

  if (project?.backgroundPath) {
    return 'image';
  }

  const hasPattern = Boolean(project?.backgroundPattern && project.backgroundPattern.id !== 'none');
  if (hasPattern) {
    return 'pattern';
  }

  return 'color';
}

export interface PreviewAssetSources {
  videoSrc: string;
  webcamSrc: string;
  backgroundImageSrc: string;
}

export function getPreviewAssetSources(
  project: Project | null,
  webcamSourcePath: string | undefined,
): PreviewAssetSources {
  const backgroundMode = resolveBackgroundMode(project);

  return {
    videoSrc: toFileUrl(project?.rawVideoPath),
    webcamSrc: toFileUrl(webcamSourcePath),
    backgroundImageSrc: backgroundMode === 'image' ? toFileUrl(project?.backgroundPath) : '',
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
  const backgroundMode = resolveBackgroundMode(project);
  const selectedPattern =
    backgroundMode === 'pattern' ? (project?.backgroundPattern ?? null) : null;
  const canvasBackgroundEnabled = project?.canvasBackgroundEnabled !== false;
  const containerStyle =
    backgroundMode === 'pattern' && selectedPattern?.containerStyle
      ? selectedPattern.containerStyle
      : {};

  return {
    selectedPattern,
    hasPattern:
      canvasBackgroundEnabled &&
      backgroundMode === 'pattern' &&
      selectedPattern !== null &&
      selectedPattern.id !== 'none',
    backgroundContainerStyle: canvasBackgroundEnabled
      ? {
          backgroundColor: project?.backgroundColor || '#000000',
          ...containerStyle,
        }
      : {},
    shouldRenderBackground: canvasBackgroundEnabled,
  };
}
