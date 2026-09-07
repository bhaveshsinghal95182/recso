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

/** The webcam's inset from the frame edge, clamped so it can never invert. */
function resolveWebcamMarginPx(
  frameWidth: number,
  frameHeight: number,
  webcamConfig: WebcamOverlayConfig,
): number {
  return clamp(
    Math.round(
      Number.isFinite(webcamConfig.marginPx) ? webcamConfig.marginPx : DEFAULT_WEBCAM_MARGIN_PX,
    ),
    0,
    Math.max(0, Math.floor(Math.min(frameWidth, frameHeight) / 2)),
  );
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
  const margin = resolveWebcamMarginPx(frameWidth, frameHeight, webcamConfig);

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

/**
 * The box a webcam zoom region should use, at its own `heightRatio`.
 *
 * The anchor grid is only half the story. A webcam the user dragged on the
 * preview carries an explicit `layout`, and the region path used to drop that
 * and fall back to `anchor` -- which is still wherever it was before the drag.
 * So a camera dragged to the bottom-right jumped to the middle the moment a
 * region began and slid back at the end, having never been anchored centre in
 * the first place.
 *
 * With a custom position the region resizes the box about its own centre, which
 * is where the camera visibly is, then pushes it back inside the margin. A
 * corner-parked camera therefore grows into its corner instead of off-frame.
 */
export function computeWebcamRegionLayout(
  frameWidth: number,
  frameHeight: number,
  webcamConfig: WebcamOverlayConfig,
  heightRatio: number,
): VideoLayout {
  // `layout` cleared so the size comes from `heightRatio` rather than handing
  // back the rect already resolved for the base.
  const resized = computeWebcamLayout(frameWidth, frameHeight, {
    ...webcamConfig,
    heightRatio,
    layout: undefined,
  });

  const custom = webcamConfig.layout;
  if (!custom) {
    return resized;
  }

  const margin = resolveWebcamMarginPx(frameWidth, frameHeight, webcamConfig);
  const centerX = custom.x + custom.width / 2;
  const centerY = custom.y + custom.height / 2;

  // `computeWebcamLayout` already caps the box at the frame less both margins,
  // so these ranges are never inverted.
  return {
    ...resized,
    x: clamp(
      Math.round(centerX - resized.width / 2),
      margin,
      Math.max(margin, frameWidth - margin - resized.width),
    ),
    y: clamp(
      Math.round(centerY - resized.height / 2),
      margin,
      Math.max(margin, frameHeight - margin - resized.height),
    ),
  };
}
