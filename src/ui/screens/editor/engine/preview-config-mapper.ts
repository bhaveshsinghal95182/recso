import { useEffect, useMemo, useState } from 'react';

import type { CutRegion, Project, RecordedMouseEvent, ZoomRegion } from '@/types';

import { resolveProjectWebcamSourcePath } from './export-pipeline/source-paths';
import { getPreviewAssetSources, getPreviewBackgroundPresentation } from './preview-config/assets';
import {
  buildPreviewCompositionConfig,
  mapLegacyZoomConfigToZoomKeyframes,
} from './preview-config/composition';
import {
  buildFallbackPreviewLayoutSnapshot,
  calculateFallbackLayout,
  calculateFallbackWebcamLayout,
  DEFAULT_CANVAS_SIZE,
  loadPreviewLayoutSnapshot,
} from './preview-config/layout';
import type {
  CanvasSize,
  EnginePreviewMappedConfig as PreviewMappedConfig,
} from './preview-config/types';
import type { CompositionLayout } from './types';

export type { EnginePreviewMappedConfig } from './preview-config/types';

export function useEnginePreviewConfigMapper(
  project: Project | null,
  zoomRegions: ZoomRegion[],
  cuts: CutRegion[],
  mouseEvents: RecordedMouseEvent[],
): PreviewMappedConfig {
  const durationMs = project?.timeline?.duration || 0;
  const [canvasSize, setCanvasSize] = useState<CanvasSize>(DEFAULT_CANVAS_SIZE);
  const [backendLayout, setBackendLayout] = useState<CompositionLayout | null>(null);
  const [backendWebcamLayout, setBackendWebcamLayout] = useState<CompositionLayout | null>(null);

  const webcamSourcePath = useMemo(() => resolveProjectWebcamSourcePath(project), [project]);

  useEffect(() => {
    if (!project?.videoDimensions) {
      setCanvasSize(DEFAULT_CANVAS_SIZE);
      setBackendLayout(null);
      setBackendWebcamLayout(null);
      return;
    }

    let cancelled = false;

    const syncLayoutFromBackend = async () => {
      try {
        const snapshot = await loadPreviewLayoutSnapshot(project, webcamSourcePath);
        if (cancelled) {
          return;
        }

        setCanvasSize(snapshot.canvasSize);
        setBackendLayout(snapshot.layout);
        setBackendWebcamLayout(snapshot.webcamLayout);
      } catch {
        if (cancelled) {
          return;
        }

        const fallbackSnapshot = buildFallbackPreviewLayoutSnapshot(project, webcamSourcePath);
        setCanvasSize(fallbackSnapshot.canvasSize);
        setBackendLayout(fallbackSnapshot.layout);
        setBackendWebcamLayout(fallbackSnapshot.webcamLayout);
      }
    };

    void syncLayoutFromBackend();

    return () => {
      cancelled = true;
    };
  }, [
    project?.videoDimensions?.height,
    project?.videoDimensions?.width,
    project?.webcamOverlay,
    webcamSourcePath,
  ]);

  const layout = useMemo<CompositionLayout>(() => {
    if (!project?.videoDimensions) {
      return {
        x: 0,
        y: 0,
        width: canvasSize.width,
        height: canvasSize.height,
        scale: 1,
      };
    }

    if (backendLayout) {
      return backendLayout;
    }

    return calculateFallbackLayout(
      project.videoDimensions.width,
      project.videoDimensions.height,
      canvasSize.width,
      canvasSize.height,
    );
  }, [backendLayout, canvasSize.height, canvasSize.width, project?.videoDimensions]);

  const legacyZoomFallback = useMemo(
    () =>
      mapLegacyZoomConfigToZoomKeyframes(project?.zoomConfig, durationMs, zoomRegions.length > 0),
    [durationMs, project?.zoomConfig, zoomRegions.length],
  );

  const webcamLayout = useMemo<CompositionLayout | null>(() => {
    if (!project?.webcamOverlay?.enabled || !webcamSourcePath) {
      return null;
    }

    if (backendWebcamLayout) {
      return backendWebcamLayout;
    }

    return calculateFallbackWebcamLayout(
      canvasSize.width,
      canvasSize.height,
      project.webcamOverlay,
    );
  }, [
    backendWebcamLayout,
    canvasSize.height,
    canvasSize.width,
    project?.webcamOverlay,
    webcamSourcePath,
  ]);

  const compositionConfig = useMemo(
    () =>
      buildPreviewCompositionConfig({
        project,
        layout,
        zoomRegions,
        cuts,
        legacyZoomFallback,
        mouseEvents,
        webcamLayout,
        webcamSourcePath,
      }),
    [
      cuts,
      layout,
      legacyZoomFallback,
      mouseEvents,
      project,
      webcamLayout,
      webcamSourcePath,
      zoomRegions,
    ],
  );

  const previewAssets = useMemo(
    () => getPreviewAssetSources(project, webcamSourcePath),
    [project, webcamSourcePath],
  );

  const previewBackgroundPresentation = useMemo(
    () => getPreviewBackgroundPresentation(project),
    [project],
  );

  return {
    canvasSize,
    layout,
    durationMs,
    compositionConfig,
    videoSrc: previewAssets.videoSrc,
    webcamSrc: previewAssets.webcamSrc,
    backgroundImageSrc: previewAssets.backgroundImageSrc,
    backgroundContainerStyle: previewBackgroundPresentation.backgroundContainerStyle,
    selectedPattern: previewBackgroundPresentation.selectedPattern,
    hasPattern: previewBackgroundPresentation.hasPattern,
  };
}
