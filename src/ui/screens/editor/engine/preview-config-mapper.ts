import type React from 'react';
import { useEffect, useMemo, useState } from 'react';

import type { CutRegion, Project, RecordedMouseEvent, ZoomRegion } from '@/types';

import { defaultConfig } from './functions';
import type { CompositionConfig, CompositionLayout, ZoomKeyframe } from './types';

type CanvasSize = {
  width: number;
  height: number;
};

export interface EnginePreviewMappedConfig {
  canvasSize: CanvasSize;
  layout: CompositionLayout;
  durationMs: number;
  compositionConfig: CompositionConfig;
  videoSrc: string;
  backgroundImageSrc: string;
  backgroundContainerStyle: React.CSSProperties;
  selectedPattern: Project['backgroundPattern'];
  hasPattern: boolean;
}

const DEFAULT_CANVAS_SIZE: CanvasSize = {
  width: 1920,
  height: 1080,
};

const DEFAULT_LAYOUT_CONFIG = {
  padding: 0.04,
  maxScale: 0.9,
  scaleUp: true,
};

const DEFAULT_VIDEO_STYLE = {
  borderRadius: 24,
  borderWidth: 8,
  borderColor: 'rgba(255, 255, 255, 0.2)',
};

const DEFAULT_ZOOM_EPSILON = 0.001;

function toFileUrl(path: string | undefined): string {
  if (!path) {
    return '';
  }

  if (path.startsWith('file:')) {
    return path;
  }

  const normalized = path.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }

  if (normalized.startsWith('/')) {
    return `file://${encodeURI(normalized)}`;
  }

  return normalized;
}

function calculateFallbackLayout(
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): CompositionLayout {
  const availableWidth =
    canvasWidth * (1 - DEFAULT_LAYOUT_CONFIG.padding * 2) * DEFAULT_LAYOUT_CONFIG.maxScale;
  const availableHeight =
    canvasHeight * (1 - DEFAULT_LAYOUT_CONFIG.padding * 2) * DEFAULT_LAYOUT_CONFIG.maxScale;

  const scaleX = availableWidth / videoWidth;
  const scaleY = availableHeight / videoHeight;

  let scale = Math.min(scaleX, scaleY);
  if (!DEFAULT_LAYOUT_CONFIG.scaleUp && scale > 1) {
    scale = 1;
  }

  const width = Math.round(videoWidth * scale);
  const height = Math.round(videoHeight * scale);
  const x = Math.round((canvasWidth - width) / 2);
  const y = Math.round((canvasHeight - height) / 2);

  return { x, y, width, height, scale };
}

function clampNormalised(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, value));
}

function mapLegacyZoomConfigToZoomKeyframes(
  zoomConfig: Project['zoomConfig'] | undefined,
  durationMs: number,
  hasZoomRegions: boolean,
): ZoomKeyframe[] {
  if (hasZoomRegions || !zoomConfig || durationMs <= 0) {
    return [];
  }

  const level = Number.isFinite(zoomConfig.level) ? Math.max(0.1, zoomConfig.level) : 1;
  if (Math.abs(level - 1) <= DEFAULT_ZOOM_EPSILON) {
    return [];
  }

  return [
    {
      startTime: 0,
      endTime: durationMs / 1000,
      focalPoint: {
        x: clampNormalised(zoomConfig.focalX),
        y: clampNormalised(zoomConfig.focalY),
      },
      multiplier: level,
      easeIn: 0,
      easeOut: 0,
    },
  ];
}

function buildCompositionConfig(
  project: Project | null,
  layout: CompositionLayout,
  zoomRegions: ZoomRegion[],
  cuts: CutRegion[],
  legacyZoomFallback: ZoomKeyframe[],
  mouseEvents: RecordedMouseEvent[],
): CompositionConfig {
  const sourceWidth = project?.videoDimensions?.width ?? 0;
  const sourceHeight = project?.videoDimensions?.height ?? 0;
  const rawCursor = project?.cursorConfig;

  return {
    ...defaultConfig,
    background: {
      enabled: false,
      type: 'color',
      color: 'transparent',
    },
    video: {
      scale: layout.scale,
      borderRadius: DEFAULT_VIDEO_STYLE.borderRadius,
      border: {
        width: DEFAULT_VIDEO_STYLE.borderWidth,
        color: DEFAULT_VIDEO_STYLE.borderColor,
      },
    },
    layout,
    zooms: legacyZoomFallback,
    zoomRegions: zoomRegions.map((region) => ({
      id: region.id,
      startMs: region.startMs,
      endMs: region.endMs,
      zoomLevel: region.zoomLevel,
      focalX: region.focalX,
      focalY: region.focalY,
      easeDurationMs: region.easeDurationMs,
      focalKeyframes: region.focalKeyframes,
    })),
    cuts: cuts.map((cut) => ({
      id: cut.id,
      startMs: cut.startMs,
      endMs: cut.endMs,
    })),
    cursor: {
      enabled: true,
      size: Number.isFinite(rawCursor?.size) ? Math.max(0.2, rawCursor?.size ?? 1) : 1,
      style: rawCursor?.style ?? 'default',
      customImagePath: rawCursor?.customImagePath,
      showClickAnimations: rawCursor?.showClickAnimations ?? true,
      clickAnimationScale: Number.isFinite(rawCursor?.clickAnimationScale)
        ? Math.max(0.5, rawCursor?.clickAnimationScale ?? 1.2)
        : 1.2,
      clickDisplayDuration: Number.isFinite(rawCursor?.clickDisplayDuration)
        ? Math.max(80, rawCursor?.clickDisplayDuration ?? 500)
        : 500,
      showMotionBlur: rawCursor?.showMotionBlur ?? true,
      motionBlurStrength: Number.isFinite(rawCursor?.motionBlurStrength)
        ? Math.max(0, Math.min(2.5, rawCursor?.motionBlurStrength ?? 0.7))
        : 0.7,
      sourceWidth,
      sourceHeight,
      events: [...mouseEvents]
        .filter((event) => Number.isFinite(event.timestampMs))
        .sort((a, b) => a.timestampMs - b.timestampMs)
        .map((event) => ({
          timestampMs: event.timestampMs,
          x: event.x,
          y: event.y,
          normalizedX: event.normalizedX,
          normalizedY: event.normalizedY,
          cursorDataUrl: event.cursorDataUrl,
          cursorHotspotX: event.cursorHotspotX,
          cursorHotspotY: event.cursorHotspotY,
          cursorHandleHex: event.cursorHandleHex,
          eventType: event.eventType,
          button: event.button,
        })),
    },
  };
}

export function useEnginePreviewConfigMapper(
  project: Project | null,
  zoomRegions: ZoomRegion[],
  cuts: CutRegion[],
  mouseEvents: RecordedMouseEvent[],
): EnginePreviewMappedConfig {
  const durationMs = project?.timeline?.duration || 0;
  const [canvasSize, setCanvasSize] = useState<CanvasSize>(DEFAULT_CANVAS_SIZE);
  const [backendLayout, setBackendLayout] = useState<CompositionLayout | null>(null);

  useEffect(() => {
    if (!project?.videoDimensions) {
      setCanvasSize(DEFAULT_CANVAS_SIZE);
      setBackendLayout(null);
      return;
    }

    let cancelled = false;

    const syncLayoutFromBackend = async () => {
      try {
        const nextCanvas = await window.electron.compositor.getCanvasSize();
        const nextLayout = await window.electron.compositor.calculateLayout(
          {
            width: project.videoDimensions.width,
            height: project.videoDimensions.height,
          },
          nextCanvas,
        );

        if (cancelled) {
          return;
        }

        setCanvasSize(nextCanvas);
        setBackendLayout(nextLayout);
      } catch {
        if (cancelled) {
          return;
        }

        setCanvasSize(DEFAULT_CANVAS_SIZE);
        setBackendLayout(
          calculateFallbackLayout(
            project.videoDimensions.width,
            project.videoDimensions.height,
            DEFAULT_CANVAS_SIZE.width,
            DEFAULT_CANVAS_SIZE.height,
          ),
        );
      }
    };

    void syncLayoutFromBackend();

    return () => {
      cancelled = true;
    };
  }, [project?.videoDimensions?.height, project?.videoDimensions?.width]);

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

  const compositionConfig = useMemo(
    () =>
      buildCompositionConfig(project, layout, zoomRegions, cuts, legacyZoomFallback, mouseEvents),
    [cuts, layout, legacyZoomFallback, mouseEvents, project, zoomRegions],
  );

  const videoSrc = useMemo(() => toFileUrl(project?.rawVideoPath), [project?.rawVideoPath]);
  const backgroundImageSrc = useMemo(
    () => toFileUrl(project?.backgroundPath),
    [project?.backgroundPath],
  );

  const selectedPattern = project?.backgroundPattern ?? null;
  const hasPattern = selectedPattern !== null && selectedPattern.id !== 'none';

  const backgroundContainerStyle = useMemo<React.CSSProperties>(
    () => ({
      backgroundColor: project?.backgroundColor || '#000000',
      ...(selectedPattern?.containerStyle || {}),
    }),
    [project?.backgroundColor, selectedPattern],
  );

  return {
    canvasSize,
    layout,
    durationMs,
    compositionConfig,
    videoSrc,
    backgroundImageSrc,
    backgroundContainerStyle,
    selectedPattern,
    hasPattern,
  };
}
