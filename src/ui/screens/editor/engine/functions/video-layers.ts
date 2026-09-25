import type {
  Canvas2DContext,
  FrameVideoSource,
  ShadowLayer,
  VideoConfig,
  VideoLayout,
  WebcamOverlayConfig,
} from '../types';
import { clamp, roundRectPath } from './common';
import { computeWebcamLayout, computeWebcamRegionLayout } from './layout';

/**
 * Paint a stack of drop shadows under a shape.
 *
 * One pass per layer, because canvas only holds one shadow at a time -- the
 * stack is what makes it read as depth rather than as a smudge, so they cannot
 * be collapsed into one.
 *
 * `scale` is the zoom the layer is drawn at. Canvas offsets and blurs are in
 * device space and the current transform does *not* apply to them, unlike the
 * path itself -- so under a 2x zoom the shape doubles and the shadow would not,
 * and the picture would visibly come loose from its own shadow. The engine
 * scales its shadows for the same reason, and this is where the two agree.
 */
function drawShadowStack(
  ctx: Canvas2DContext,
  shadows: ShadowLayer[] | undefined,
  scale: number,
  tracePath: () => void,
): void {
  if (!shadows || shadows.length === 0) {
    return;
  }

  for (const shadow of shadows) {
    const blur = Number.isFinite(shadow.blur) ? Math.max(0, shadow.blur) : 0;
    if (blur <= 0 && shadow.offsetX === 0 && shadow.offsetY === 0) {
      continue;
    }

    ctx.save();
    ctx.shadowColor = shadow.color;
    ctx.shadowBlur = blur * scale;
    ctx.shadowOffsetX = shadow.offsetX * scale;
    ctx.shadowOffsetY = shadow.offsetY * scale;
    tracePath();
    // The layer itself is drawn over this a moment later, so the fill is
    // covered. It stays opaque so a low-alpha shadow is still cast at the
    // alpha it asked for rather than at the fill's.
    ctx.fillStyle = 'rgba(0, 0, 0, 1)';
    ctx.fill();
    ctx.restore();
  }
}

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
  zoomScale = 1,
): void {
  // Under everything, and cast by the recording's own rectangle rather than the
  // bordered one -- a thick border sits on top of the shadow's inner edge. That
  // is the one place this does not look like a CSS box-shadow, and the engine
  // makes the same choice so the two paths match.
  drawShadowStack(ctx, videoConfig.shadows, zoomScale, () =>
    roundRectPath(ctx, layout.x, layout.y, layout.width, layout.height, videoConfig.borderRadius),
  );

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
  // Scale 1: the camera is drawn in base space, so there is no zoom to
  // compensate for.
  drawShadowStack(ctx, webcamConfig.shadows, 1, () =>
    beginWebcamShapePath(ctx, layout, webcamConfig),
  );
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
  // config copy that forces layout recalculation with the new ratio. A camera
  // the user dragged keeps its position through the region rather than snapping
  // back to the anchor grid, so the resolved rect is handed straight back.
  const baseConfig =
    activeWebcamHeightRatio !== undefined
      ? {
          ...webcamConfig,
          heightRatio: activeWebcamHeightRatio,
          layout: webcamConfig.layout
            ? computeWebcamRegionLayout(
                frameWidth,
                frameHeight,
                webcamConfig,
                activeWebcamHeightRatio,
              )
            : undefined,
        }
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
