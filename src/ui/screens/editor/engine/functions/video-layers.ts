import type {
  Canvas2DContext,
  FrameVideoSource,
  VideoConfig,
  VideoLayout,
  WebcamOverlayConfig,
} from '../types';
import { clamp, roundRectPath } from './common';
import { computeWebcamLayout } from './layout';

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
    roundRectPath(ctx, layout.x, layout.y, layout.width, layout.height, webcamConfig.borderRadius);
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
    roundRectPath(
      ctx,
      layout.x - borderWidth,
      layout.y - borderWidth,
      layout.width + borderWidth * 2,
      layout.height + borderWidth * 2,
      webcamConfig.borderRadius + borderWidth,
    );
    ctx.fillStyle = webcamConfig.border.color;
    ctx.fill();
  }

  roundRectPath(ctx, layout.x, layout.y, layout.width, layout.height, webcamConfig.borderRadius);
  ctx.clip();
  source.draw(ctx, layout.x, layout.y, layout.width, layout.height);
  ctx.restore();
}
