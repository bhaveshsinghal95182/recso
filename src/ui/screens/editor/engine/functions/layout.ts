import type { CompositionConfig, VideoLayout, WebcamOverlayConfig } from '../types';
import { resolveAnchoredPosition } from '../webcam-anchor';
import {
  clamp,
  DEFAULT_WEBCAM_ASPECT_RATIO,
  DEFAULT_WEBCAM_HEIGHT_RATIO,
  DEFAULT_WEBCAM_MARGIN_PX,
} from './common';

export function computeVideoLayout(
  frameWidth: number,
  frameHeight: number,
  config: CompositionConfig,
): VideoLayout {
  if (config.layout) {
    return {
      x: config.layout.x,
      y: config.layout.y,
      width: config.layout.width,
      height: config.layout.height,
      scale: config.layout.scale,
    };
  }

  const videoScale = config.background.enabled ? config.video.scale : 1;
  const width = frameWidth * videoScale;
  const height = frameHeight * videoScale;
  const x = (frameWidth - width) / 2;
  const y = (frameHeight - height) / 2;

  return { x, y, width, height, scale: videoScale };
}

export function computeWebcamLayout(
  frameWidth: number,
  frameHeight: number,
  webcamConfig: WebcamOverlayConfig,
): VideoLayout {
  if (webcamConfig.layout) {
    return {
      x: webcamConfig.layout.x,
      y: webcamConfig.layout.y,
      width: webcamConfig.layout.width,
      height: webcamConfig.layout.height,
      scale: webcamConfig.layout.scale,
    };
  }

  const aspectRatio =
    Number.isFinite(webcamConfig.aspectRatio) && webcamConfig.aspectRatio > 0
      ? webcamConfig.aspectRatio
      : DEFAULT_WEBCAM_ASPECT_RATIO;
  const heightRatio = clamp(
    Number.isFinite(webcamConfig.heightRatio)
      ? webcamConfig.heightRatio
      : DEFAULT_WEBCAM_HEIGHT_RATIO,
    0.08,
    0.75,
  );
  const margin = clamp(
    Math.round(
      Number.isFinite(webcamConfig.marginPx) ? webcamConfig.marginPx : DEFAULT_WEBCAM_MARGIN_PX,
    ),
    0,
    Math.max(0, Math.floor(Math.min(frameWidth, frameHeight) / 2)),
  );

  let height = Math.max(1, Math.round(frameHeight * heightRatio));
  let width = Math.max(1, Math.round(height * aspectRatio));

  const maxWidth = Math.max(1, frameWidth - margin * 2);
  const maxHeight = Math.max(1, frameHeight - margin * 2);

  if (width > maxWidth) {
    width = maxWidth;
    height = Math.max(1, Math.round(width / aspectRatio));
  }

  if (height > maxHeight) {
    height = maxHeight;
    width = Math.max(1, Math.round(height * aspectRatio));
  }

  const position = resolveAnchoredPosition(
    webcamConfig.anchor,
    width,
    height,
    frameWidth,
    frameHeight,
    margin,
  );

  return {
    x: position.x,
    y: position.y,
    width,
    height,
    scale: height / Math.max(1, frameHeight),
  };
}
