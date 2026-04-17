import type { Canvas2DContext, CompositionConfig, FrameVideoSource } from '../types';
import { drawBackground } from './background';
import { drawCursorLayer } from './cursor';
import { computeVideoLayout } from './layout';
import { drawVideoLayer, drawWebcamLayer } from './video-layers';
import { computeZoomStateFromConfig } from './zoom';

export interface RenderCompositionFrameOptions {
  ctx: Canvas2DContext;
  frameWidth: number;
  frameHeight: number;
  t: number;
  config: CompositionConfig;
  source: FrameVideoSource;
  webcamSource?: FrameVideoSource | null;
}

export function renderCompositionFrame({
  ctx,
  frameWidth,
  frameHeight,
  t,
  config,
  source,
  webcamSource,
}: RenderCompositionFrameOptions): void {
  const zoomState = computeZoomStateFromConfig(t, config, frameWidth, frameHeight);
  const videoLayout = computeVideoLayout(frameWidth, frameHeight, config);

  ctx.save();
  ctx.translate(zoomState.pivotX, zoomState.pivotY);
  ctx.scale(zoomState.scale, zoomState.scale);
  ctx.translate(-zoomState.pivotX, -zoomState.pivotY);

  if (config.background.enabled) {
    drawBackground(ctx, frameWidth, frameHeight, config.background);
  } else {
    ctx.clearRect(0, 0, frameWidth, frameHeight);
  }

  drawVideoLayer(ctx, videoLayout, config.video, source);
  drawCursorLayer(ctx, t, videoLayout, config.cursor);
  if (config.webcam?.enabled && webcamSource) {
    drawWebcamLayer(ctx, frameWidth, frameHeight, config.webcam, webcamSource);
  }
  ctx.restore();
}
