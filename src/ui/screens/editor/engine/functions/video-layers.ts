import type {
  Canvas2DContext,
  FrameVideoSource,
  VideoConfig,
  VideoLayout,
  WebcamOverlayConfig,
} from '../types';
import { clamp, roundRectPath } from './common';
import { computeWebcamLayout } from './layout';

function beginWebcamShapePath(
  ctx: Canvas2DContext,
  layout: VideoLayout,
  webcamConfig: WebcamOverlayConfig,
  expansion = 0,
): void {
  if (webcamConfig.shape === 'circle') {
    const radius = Math.max(0, Math.min(layout.width, layout.height) / 2 + expansion);
    const centerX = layout.x + layout.width / 2;
    const centerY = layout.y + layout.height / 2;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.closePath();
    return;
  }

  roundRectPath(
    ctx,
    layout.x - expansion,
    layout.y - expansion,
    layout.width + expansion * 2,
    layout.height + expansion * 2,
    webcamConfig.borderRadius + expansion,
  );
}

export function drawVideoLayer(
  ctx: Canvas2DContext,
  layout: VideoLayout,
  videoConfig: VideoConfig,
  source: FrameVideoSource,
): void {
  if (videoConfig.borderRadius > 0 || videoConfig.border.width > 0) {
    ctx.save();

    if (videoConfig.border.width > 0) {
      const borderWidth = videoConfig.border.width;
      roundRectPath(
        ctx,
        layout.x - borderWidth,
        layout.y - borderWidth,
        layout.width + borderWidth * 2,
        layout.height + borderWidth * 2,
        videoConfig.borderRadius + borderWidth,
      );
      ctx.fillStyle = videoConfig.border.color;
      ctx.fill();
    }

    roundRectPath(ctx, layout.x, layout.y, layout.width, layout.height, videoConfig.borderRadius);
    ctx.clip();

    source.draw(ctx, layout.x, layout.y, layout.width, layout.height);
    ctx.restore();
    return;
  }

  source.draw(ctx, layout.x, layout.y, layout.width, layout.height);
}

function drawWebcamShadowLayers(
  ctx: Canvas2DContext,
  layout: VideoLayout,
  webcamConfig: WebcamOverlayConfig,
): void {
  if (!webcamConfig.shadows || webcamConfig.shadows.length === 0) {
    return;
  }

  for (const shadow of webcamConfig.shadows) {
    const blur = Number.isFinite(shadow.blur) ? Math.max(0, shadow.blur) : 0;
    if (blur <= 0 && shadow.offsetX === 0 && shadow.offsetY === 0) {
      continue;
    }

    ctx.save();
    ctx.shadowColor = shadow.color;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = shadow.offsetX;
    ctx.shadowOffsetY = shadow.offsetY;
    beginWebcamShapePath(ctx, layout, webcamConfig);
    // The webcam layer is drawn immediately after this, so the fill is covered.
    // Keep fill opaque so low-alpha shadows remain visible.
    ctx.fillStyle = 'rgba(0, 0, 0, 1)';
    ctx.fill();
    ctx.restore();
  }
}

export function drawWebcamLayer(
  ctx: Canvas2DContext,
  frameWidth: number,
  frameHeight: number,
  webcamConfig: WebcamOverlayConfig,
  source: FrameVideoSource,
  activeWebcamHeightRatio?: number,
  activeWebcamFullScreenProgress = 0,
): void {
  // When a zoom region overrides the webcam height ratio, create a modified
  // config copy that forces layout recalculation with the new ratio.
  const baseConfig =
    activeWebcamHeightRatio !== undefined
      ? { ...webcamConfig, heightRatio: activeWebcamHeightRatio, layout: undefined }
      : webcamConfig;
  const progress = clamp(activeWebcamFullScreenProgress, 0, 1);

  const { effectiveConfig, layout } = (() => {
    if (progress <= 0) {
      const resolvedLayout = computeWebcamLayout(frameWidth, frameHeight, baseConfig);
      return { effectiveConfig: baseConfig, layout: resolvedLayout };
    }

    const baseLayout = computeWebcamLayout(frameWidth, frameHeight, baseConfig);
    const fullLayout: VideoLayout = {
      x: 0,
      y: 0,
      width: frameWidth,
      height: frameHeight,
      scale: 1,
    };
    const mix = (from: number, to: number) => from + (to - from) * progress;
    const blendedLayout: VideoLayout = {
      x: mix(baseLayout.x, fullLayout.x),
      y: mix(baseLayout.y, fullLayout.y),
      width: mix(baseLayout.width, fullLayout.width),
      height: mix(baseLayout.height, fullLayout.height),
      scale: mix(baseLayout.scale, fullLayout.scale),
    };
    const baseOpacity = clamp(Number.isFinite(baseConfig.opacity) ? baseConfig.opacity : 1, 0, 1);

    return {
      effectiveConfig: {
        ...baseConfig,
        shape: 'rectangle-landscape' as const,
        borderRadius: Math.max(0, baseConfig.borderRadius * (1 - progress)),
        opacity: mix(baseOpacity, 1),
        border: {
          ...baseConfig.border,
          width: Math.max(0, baseConfig.border.width * (1 - progress)),
        },
        shadows: progress >= 0.85 ? [] : baseConfig.shadows,
      },
      layout: blendedLayout,
    };
  })();

  drawWebcamShadowLayers(ctx, layout, effectiveConfig);

  ctx.save();
  const opacity = clamp(
    Number.isFinite(effectiveConfig.opacity) ? effectiveConfig.opacity : 1,
    0,
    1,
  );
  if (opacity < 1) {
    ctx.globalAlpha = opacity;
  }

  if (effectiveConfig.border.width > 0) {
    const borderWidth = effectiveConfig.border.width;
    beginWebcamShapePath(ctx, layout, effectiveConfig, borderWidth);
    ctx.fillStyle = effectiveConfig.border.color;
    ctx.fill();
  }

  beginWebcamShapePath(ctx, layout, effectiveConfig);
  ctx.clip();
  source.draw(ctx, layout.x, layout.y, layout.width, layout.height);
  ctx.restore();
}
