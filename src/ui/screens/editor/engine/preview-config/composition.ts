import type { CutRegion, Project, RecordedMouseEvent, ZoomRegion } from '@/types';

import {
  clamp,
  clampNormalised,
  DEFAULT_VIDEO_STYLE,
  DEFAULT_WEBCAM_STYLE,
  DEFAULT_ZOOM_EPSILON,
} from '../export-pipeline/defaults';
import { defaultConfig } from '../functions';
import { resolveCropLocalCursorPosition, resolveCroppedSourceDimensions } from '../source-crop';
import type { CompositionConfig, CompositionLayout, ZoomKeyframe } from '../types';

function cutTargetsScreen(cut: CutRegion): boolean {
  return cut.targets?.screen ?? true;
}

function cutTargetsWebcam(cut: CutRegion): boolean {
  return cut.targets?.webcam ?? true;
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

type WebcamShapePreset = 'circle' | 'rectangle-landscape' | 'rectangle-portrait' | 'square';

function isWebcamShapePreset(value: unknown): value is WebcamShapePreset {
  return (
    value === 'circle' ||
    value === 'rectangle-landscape' ||
    value === 'rectangle-portrait' ||
    value === 'square'
  );
}

function resolveWebcamShape(raw: Project['webcamOverlay']): WebcamShapePreset {
  if (isWebcamShapePreset(raw?.shape)) {
    return raw.shape;
  }

  const aspectRatio =
    Number.isFinite(raw?.aspectRatio) && (raw?.aspectRatio as number) > 0
      ? (raw?.aspectRatio as number)
      : DEFAULT_WEBCAM_STYLE.aspectRatio;

  if (Math.abs(aspectRatio - 1) <= 0.05) {
    if (Number.isFinite(raw?.borderRadiusPx) && (raw?.borderRadiusPx as number) >= 999) {
      return 'circle';
    }

    return 'square';
  }

  if (aspectRatio > 1.05) {
    return 'rectangle-landscape';
  }

  return DEFAULT_WEBCAM_STYLE.shape;
}

function normalizeCursorRegionOverrides(project: Project | null) {
  if (!project?.cursorRegionOverrides) {
    return [];
  }

  return project.cursorRegionOverrides
    .filter(
      (cursorOverride) =>
        typeof cursorOverride.imagePath === 'string' &&
        cursorOverride.imagePath.length > 0 &&
        Number.isFinite(cursorOverride.startMs) &&
        Number.isFinite(cursorOverride.endMs) &&
        cursorOverride.endMs > cursorOverride.startMs,
    )
    .map((cursorOverride) => ({
      startMs: cursorOverride.startMs,
      endMs: cursorOverride.endMs,
      imagePath: cursorOverride.imagePath,
    }))
    .sort((a, b) => a.startMs - b.startMs);
}

export function mapLegacyZoomConfigToZoomKeyframes(
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

export interface BuildPreviewCompositionConfigOptions {
  project: Project | null;
  layout: CompositionLayout;
  zoomRegions: ZoomRegion[];
  cuts: CutRegion[];
  legacyZoomFallback: ZoomKeyframe[];
  mouseEvents: RecordedMouseEvent[];
  webcamLayout: CompositionLayout | null;
  webcamSourcePath: string | undefined;
  webcamZoomRegions?: ZoomRegion[];
}

export function buildPreviewCompositionConfig({
  project,
  layout,
  zoomRegions,
  cuts,
  legacyZoomFallback,
  mouseEvents,
  webcamLayout,
  webcamSourcePath,
  webcamZoomRegions,
}: BuildPreviewCompositionConfigOptions): CompositionConfig {
  const originalSourceDimensions = {
    width: project?.videoDimensions?.width ?? 0,
    height: project?.videoDimensions?.height ?? 0,
  };
  const sourceDimensions = resolveCroppedSourceDimensions(
    originalSourceDimensions,
    project?.cropConfig,
  );
  const sourceWidth = sourceDimensions.width;
  const sourceHeight = sourceDimensions.height;
  const rawCursor = project?.cursorConfig;
  const rawWebcam = project?.webcamOverlay;
  const webcamEnabled = Boolean(rawWebcam?.enabled && webcamSourcePath);
  const webcamShape = resolveWebcamShape(rawWebcam);
  const webcamAspectRatio =
    webcamShape === 'circle' || webcamShape === 'square'
      ? 1
      : Number.isFinite(rawWebcam?.aspectRatio) && (rawWebcam?.aspectRatio as number) > 0
        ? (rawWebcam?.aspectRatio as number)
        : DEFAULT_WEBCAM_STYLE.aspectRatio;
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

  const canvasBackgroundEnabled = project?.canvasBackgroundEnabled !== false;

  return {
    ...defaultConfig,
    background: {
      enabled: false,
      type: 'color',
      color: 'transparent',
    },
    video: {
      scale: layout.scale,
      borderRadius: canvasBackgroundEnabled ? DEFAULT_VIDEO_STYLE.borderRadius : 0,
      border: canvasBackgroundEnabled
        ? {
            width: DEFAULT_VIDEO_STYLE.borderWidth,
            color: DEFAULT_VIDEO_STYLE.borderColor,
          }
        : {
            width: 0,
            color: 'transparent',
          },
    },
    webcam: webcamEnabled
      ? {
          enabled: true,
          sourcePath: webcamSourcePath,
          anchor: rawWebcam?.anchor ?? DEFAULT_WEBCAM_STYLE.anchor,
          shape: webcamShape,
          aspectRatio: webcamAspectRatio,
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
      webcamHeightRatio: region.webcamHeightRatio,
      webcamFullScreen: region.webcamFullScreen,
    })),
    webcamZoomRegions: webcamZoomRegions?.map((region) => ({
      id: region.id,
      startMs: region.startMs,
      endMs: region.endMs,
      zoomLevel: region.zoomLevel,
      focalX: region.focalX,
      focalY: region.focalY,
      easeDurationMs: region.easeDurationMs,
      focalKeyframes: region.focalKeyframes,
      webcamHeightRatio: region.webcamHeightRatio,
      webcamFullScreen: region.webcamFullScreen,
    })),
    cuts: cuts.filter(cutTargetsScreen).map((cut) => ({
      id: cut.id,
      startMs: cut.startMs,
      endMs: cut.endMs,
    })),
    webcamCuts: cuts.filter(cutTargetsWebcam).map((cut) => ({
      id: cut.id,
      startMs: cut.startMs,
      endMs: cut.endMs,
    })),
    cursor: {
      enabled: true,
      size: Number.isFinite(rawCursor?.size) ? Math.max(0.2, rawCursor?.size ?? 1) : 1,
      style: rawCursor?.style ?? 'default',
      customImagePath: rawCursor?.customImagePath,
      cursorRegionOverrides: normalizeCursorRegionOverrides(project),
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
        .map((event) => {
          const cursorPosition = resolveCropLocalCursorPosition(
            event,
            originalSourceDimensions,
            project?.cropConfig,
          );

          return {
            timestampMs: event.timestampMs,
            x: cursorPosition.x,
            y: cursorPosition.y,
            normalizedX: cursorPosition.normalizedX,
            normalizedY: cursorPosition.normalizedY,
            cursorDataUrl: event.cursorDataUrl,
            cursorHotspotX: event.cursorHotspotX,
            cursorHotspotY: event.cursorHotspotY,
            cursorHandleHex: event.cursorHandleHex,
            eventType: event.eventType,
            button: event.button,
          };
        }),
    },
  };
}
