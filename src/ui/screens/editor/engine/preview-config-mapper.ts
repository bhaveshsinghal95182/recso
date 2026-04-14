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
  webcamSrc: string;
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

const DEFAULT_WEBCAM_STYLE = {
  anchor: 'bottom-right' as const,
  aspectRatio: 9 / 16,
  heightRatio: 0.28,
  marginPx: 24,
  borderRadius: 3,
  borderWidth: 0,
  borderColor: 'rgba(255, 255, 255, 0.42)',
  opacity: 1,
  shadows: [
    { offsetX: -1, offsetY: 2, blur: 4, color: 'rgba(0, 0, 0, 0.16)' },
    { offsetX: -3, offsetY: 6, blur: 10, color: 'rgba(0, 0, 0, 0.10)' },
    { offsetX: 0, offsetY: 1, blur: 2, color: 'rgba(0, 0, 0, 0.12)' },
  ],
};

const DEFAULT_ZOOM_EPSILON = 0.001;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function inferWebcamPathFromRawVideo(rawVideoPath: string | undefined): string | undefined {
  if (!rawVideoPath) {
    return undefined;
  }

  const lastDot = rawVideoPath.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === rawVideoPath.length - 1) {
    return undefined;
  }

  return `${rawVideoPath.slice(0, lastDot)}_camera${rawVideoPath.slice(lastDot)}`;
}

function resolveProjectWebcamSourcePath(project: Project | null): string | undefined {
  const explicitPath = project?.webcamOverlay?.sourcePath?.trim();
  if (explicitPath) {
    return explicitPath;
  }

  return inferWebcamPathFromRawVideo(project?.rawVideoPath);
}

function resolveWebcamShadows(raw: Project['webcamOverlay']) {
  if (!raw?.shadows || raw.shadows.length === 0) {
    return DEFAULT_WEBCAM_STYLE.shadows;
  }

  const mapped = raw.shadows
    .map((shadow) => {
      const blur = Number.isFinite(shadow.blur) ? Math.max(0, shadow.blur) : 0;
      const offsetX = Number.isFinite(shadow.offsetX) ? shadow.offsetX : 0;
      const offsetY = Number.isFinite(shadow.offsetY) ? shadow.offsetY : 0;
      const color = typeof shadow.color === 'string' ? shadow.color : 'rgba(0, 0, 0, 0.12)';

      return {
        blur,
        offsetX,
        offsetY,
        color,
      };
    })
    .filter((shadow) => shadow.blur > 0 || shadow.offsetX !== 0 || shadow.offsetY !== 0);

  return mapped.length > 0 ? mapped : DEFAULT_WEBCAM_STYLE.shadows;
}

function calculateFallbackWebcamLayout(
  canvasWidth: number,
  canvasHeight: number,
  webcamOverlay: Project['webcamOverlay'],
): CompositionLayout {
  const aspectRatio =
    Number.isFinite(webcamOverlay?.aspectRatio) && (webcamOverlay?.aspectRatio as number) > 0
      ? (webcamOverlay?.aspectRatio as number)
      : DEFAULT_WEBCAM_STYLE.aspectRatio;
  const heightRatio = clamp(
    Number.isFinite(webcamOverlay?.heightRatio)
      ? (webcamOverlay?.heightRatio as number)
      : DEFAULT_WEBCAM_STYLE.heightRatio,
    0.08,
    0.75,
  );
  const marginPx = clamp(
    Math.round(
      Number.isFinite(webcamOverlay?.marginPx)
        ? (webcamOverlay?.marginPx as number)
        : DEFAULT_WEBCAM_STYLE.marginPx,
    ),
    0,
    Math.floor(Math.min(canvasWidth, canvasHeight) / 2),
  );

  let height = Math.max(1, Math.round(canvasHeight * heightRatio));
  let width = Math.max(1, Math.round(height * aspectRatio));

  const maxWidth = Math.max(1, canvasWidth - marginPx * 2);
  const maxHeight = Math.max(1, canvasHeight - marginPx * 2);

  if (width > maxWidth) {
    width = maxWidth;
    height = Math.max(1, Math.round(width / aspectRatio));
  }

  if (height > maxHeight) {
    height = maxHeight;
    width = Math.max(1, Math.round(height * aspectRatio));
  }

  const anchor = webcamOverlay?.anchor ?? DEFAULT_WEBCAM_STYLE.anchor;
  let x = marginPx;
  let y = marginPx;
  switch (anchor) {
    case 'top-right':
      x = canvasWidth - width - marginPx;
      y = marginPx;
      break;
    case 'bottom-left':
      x = marginPx;
      y = canvasHeight - height - marginPx;
      break;
    case 'bottom-right':
      x = canvasWidth - width - marginPx;
      y = canvasHeight - height - marginPx;
      break;
    case 'top-left':
    default:
      x = marginPx;
      y = marginPx;
      break;
  }

  return {
    x: clamp(Math.round(x), 0, Math.max(0, canvasWidth - width)),
    y: clamp(Math.round(y), 0, Math.max(0, canvasHeight - height)),
    width,
    height,
    scale: height / Math.max(1, canvasHeight),
  };
}

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
  webcamLayout: CompositionLayout | null,
  webcamSourcePath: string | undefined,
): CompositionConfig {
  const sourceWidth = project?.videoDimensions?.width ?? 0;
  const sourceHeight = project?.videoDimensions?.height ?? 0;
  const rawCursor = project?.cursorConfig;
  const rawWebcam = project?.webcamOverlay;
  const webcamEnabled = Boolean(rawWebcam?.enabled && webcamSourcePath);
  const webcamBorderRadius = Number.isFinite(rawWebcam?.borderRadiusPx)
    ? Math.max(0, rawWebcam?.borderRadiusPx ?? DEFAULT_WEBCAM_STYLE.borderRadius)
    : DEFAULT_WEBCAM_STYLE.borderRadius;
  const webcamBorderWidth = Number.isFinite(rawWebcam?.borderWidthPx)
    ? Math.max(0, rawWebcam?.borderWidthPx ?? DEFAULT_WEBCAM_STYLE.borderWidth)
    : DEFAULT_WEBCAM_STYLE.borderWidth;
  const webcamOpacity = clamp(
    Number.isFinite(rawWebcam?.opacity)
      ? (rawWebcam?.opacity as number)
      : DEFAULT_WEBCAM_STYLE.opacity,
    0,
    1,
  );

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
    webcam: webcamEnabled
      ? {
          enabled: true,
          sourcePath: webcamSourcePath,
          anchor: rawWebcam?.anchor ?? DEFAULT_WEBCAM_STYLE.anchor,
          aspectRatio:
            Number.isFinite(rawWebcam?.aspectRatio) && (rawWebcam?.aspectRatio as number) > 0
              ? (rawWebcam?.aspectRatio as number)
              : DEFAULT_WEBCAM_STYLE.aspectRatio,
          heightRatio: clamp(
            Number.isFinite(rawWebcam?.heightRatio)
              ? (rawWebcam?.heightRatio as number)
              : DEFAULT_WEBCAM_STYLE.heightRatio,
            0.08,
            0.75,
          ),
          marginPx: Number.isFinite(rawWebcam?.marginPx)
            ? Math.max(0, rawWebcam?.marginPx as number)
            : DEFAULT_WEBCAM_STYLE.marginPx,
          borderRadius: webcamBorderRadius,
          opacity: webcamOpacity,
          border: {
            width: webcamBorderWidth,
            color: rawWebcam?.borderColor ?? DEFAULT_WEBCAM_STYLE.borderColor,
          },
          shadows: resolveWebcamShadows(rawWebcam),
          layout: webcamLayout ?? undefined,
        }
      : undefined,
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
        const nextCanvas = await window.electron.compositor.getCanvasSize();
        const nextLayout = await window.electron.compositor.calculateLayout(
          {
            width: project.videoDimensions.width,
            height: project.videoDimensions.height,
          },
          nextCanvas,
        );

        let nextWebcamLayout: CompositionLayout | null = null;
        if (project.webcamOverlay?.enabled && webcamSourcePath) {
          nextWebcamLayout = await window.electron.compositor.calculateWebcamLayout(nextCanvas, {
            anchor: project.webcamOverlay.anchor ?? DEFAULT_WEBCAM_STYLE.anchor,
            aspectRatio:
              Number.isFinite(project.webcamOverlay.aspectRatio) &&
              (project.webcamOverlay.aspectRatio as number) > 0
                ? (project.webcamOverlay.aspectRatio as number)
                : DEFAULT_WEBCAM_STYLE.aspectRatio,
            heightRatio:
              Number.isFinite(project.webcamOverlay.heightRatio) &&
              (project.webcamOverlay.heightRatio as number) > 0
                ? (project.webcamOverlay.heightRatio as number)
                : DEFAULT_WEBCAM_STYLE.heightRatio,
            marginPx: Number.isFinite(project.webcamOverlay.marginPx)
              ? Math.max(0, project.webcamOverlay.marginPx as number)
              : DEFAULT_WEBCAM_STYLE.marginPx,
          });
        }

        if (cancelled) {
          return;
        }

        setCanvasSize(nextCanvas);
        setBackendLayout(nextLayout);
        setBackendWebcamLayout(nextWebcamLayout);
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

        if (project.webcamOverlay?.enabled && webcamSourcePath) {
          setBackendWebcamLayout(
            calculateFallbackWebcamLayout(
              DEFAULT_CANVAS_SIZE.width,
              DEFAULT_CANVAS_SIZE.height,
              project.webcamOverlay,
            ),
          );
        } else {
          setBackendWebcamLayout(null);
        }
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
      buildCompositionConfig(
        project,
        layout,
        zoomRegions,
        cuts,
        legacyZoomFallback,
        mouseEvents,
        webcamLayout,
        webcamSourcePath,
      ),
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

  const videoSrc = useMemo(() => toFileUrl(project?.rawVideoPath), [project?.rawVideoPath]);
  const webcamSrc = useMemo(() => toFileUrl(webcamSourcePath), [webcamSourcePath]);
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
    webcamSrc,
    backgroundImageSrc,
    backgroundContainerStyle,
    selectedPattern,
    hasPattern,
  };
}
