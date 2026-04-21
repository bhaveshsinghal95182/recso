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
): void {
  const layout = computeWebcamLayout(frameWidth, frameHeight, webcamConfig);

  drawWebcamShadowLayers(ctx, layout, webcamConfig);

  ctx.save();
  const opacity = clamp(Number.isFinite(webcamConfig.opacity) ? webcamConfig.opacity : 1, 0, 1);
  if (opacity < 1) {
    ctx.globalAlpha = opacity;
  }

  if (webcamConfig.border.width > 0) {
    const borderWidth = webcamConfig.border.width;
    beginWebcamShapePath(ctx, layout, webcamConfig, borderWidth);
    ctx.fillStyle = webcamConfig.border.color;
    ctx.fill();
  }

  beginWebcamShapePath(ctx, layout, webcamConfig);
  ctx.clip();
  source.draw(ctx, layout.x, layout.y, layout.width, layout.height);
  ctx.restore();
}
