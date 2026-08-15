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
  calculateFallbackWebcamLayout,
  DEFAULT_CANVAS_SIZE,
  loadPreviewLayoutSnapshot,
} from './preview-config/layout';
import type {
  CanvasSize,
  EnginePreviewMappedConfig as PreviewMappedConfig,
} from './preview-config/types';
import { resolveProjectCanvasLayout } from './canvas-layout';
import { resolveCroppedSourceDimensions } from './source-crop';
import type { CompositionLayout } from './types';

export type { EnginePreviewMappedConfig } from './preview-config/types';

export function useEnginePreviewConfigMapper(
  project: Project | null,
  zoomRegions: ZoomRegion[],
  cuts: CutRegion[],
  mouseEvents: RecordedMouseEvent[],
  webcamZoomRegions?: ZoomRegion[],
): PreviewMappedConfig {
  const durationMs = project?.timeline?.duration || 0;
  const [canvasSize, setCanvasSize] = useState<CanvasSize>(DEFAULT_CANVAS_SIZE);
  const [backendWebcamLayout, setBackendWebcamLayout] = useState<CompositionLayout | null>(null);

  const webcamSourcePath = useMemo(() => resolveProjectWebcamSourcePath(project), [project]);

  useEffect(() => {
    if (!project?.videoDimensions) {
      setCanvasSize(DEFAULT_CANVAS_SIZE);
      setBackendWebcamLayout(null);
      return;
    }

    let cancelled = false;
    setBackendWebcamLayout(null);

    const syncLayoutFromBackend = async () => {
      try {
        const snapshot = await loadPreviewLayoutSnapshot(project, webcamSourcePath);
        if (cancelled) {
          return;
        }

        setCanvasSize(snapshot.canvasSize);
        setBackendWebcamLayout(snapshot.webcamLayout);
      } catch {
        if (cancelled) {
          return;
        }

        const fallbackSnapshot = buildFallbackPreviewLayoutSnapshot(project, webcamSourcePath);
        setCanvasSize(fallbackSnapshot.canvasSize);
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
    project?.canvasBackgroundEnabled,
    project?.cropConfig,
    project?.webcamOverlay,
    webcamSourcePath,
  ]);

  // Padding changes land here immediately — no round trip to the main process.
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

    return resolveProjectCanvasLayout(
      project,
      resolveCroppedSourceDimensions(project.videoDimensions, project.cropConfig),
      canvasSize,
    );
  }, [
    canvasSize.height,
    canvasSize.width,
    project?.canvasBackgroundEnabled,
    project?.canvasPadding,
    project?.cropConfig,
    project?.videoDimensions,
  ]);

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
        webcamZoomRegions,
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
      webcamZoomRegions,
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
    webcamLayout,
    durationMs,
    compositionConfig,
    videoSrc: previewAssets.videoSrc,
    webcamSrc: previewAssets.webcamSrc,
    backgroundImageSrc: previewAssets.backgroundImageSrc,
    backgroundContainerStyle: previewBackgroundPresentation.backgroundContainerStyle,
    selectedPattern: previewBackgroundPresentation.selectedPattern,
    hasPattern: previewBackgroundPresentation.hasPattern,
    shouldRenderBackground: previewBackgroundPresentation.shouldRenderBackground,
  };
}
