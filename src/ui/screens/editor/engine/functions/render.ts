import type {
  Canvas2DContext,
  CompositionConfig,
  CompositionLayerId,
  CompositionLayerSpace,
  CompositionLayerState,
  FrameVideoSource,
  VideoLayout,
} from '../types';
import { drawBackground } from './background';
import { drawCursorLayer } from './cursor';
import { isInCutRegion } from './cuts';
import { computeVideoLayout } from './layout';
import { drawVideoLayer, drawWebcamLayer } from './video-layers';
import {
  computeActiveWebcamFullScreenProgress,
  computeActiveWebcamHeightRatio,
  computeZoomStateFromConfig,
} from './zoom';

interface ResolvedLayerState {
  id: CompositionLayerId;
  space: CompositionLayerSpace;
}

interface LayerRenderContext {
  ctx: Canvas2DContext;
  frameWidth: number;
  frameHeight: number;
  t: number;
  config: CompositionConfig;
  source: FrameVideoSource;
  webcamSource?: FrameVideoSource | null;
  videoLayout: VideoLayout;
  /**
   * The zoom the `zoomed` layers are drawn at.
   *
   * Needed because canvas shadow offsets and blurs ignore the current
   * transform, so the video's shadow has to be scaled by hand to stay attached
   * to a zoomed recording.
   */
  zoomScale: number;
  /** Active webcam height ratio override from a zoom region, if any. */
  activeWebcamHeightRatio?: number;
  /** Active webcam full-canvas transition progress from a zoom region, if any. */
  activeWebcamFullScreenProgress?: number;
}

type LayerRenderer = (context: LayerRenderContext) => void;

interface LayerDefinition {
  defaultSpace: CompositionLayerSpace;
  render: LayerRenderer;
}

// Single extension point for adding/changing layers.
const LAYER_DEFINITIONS: Record<CompositionLayerId, LayerDefinition> = {
  background: {
    defaultSpace: 'base',
    render: ({ ctx, frameWidth, frameHeight, config }) => {
      if (config.background.enabled) {
        drawBackground(ctx, frameWidth, frameHeight, config.background);
      } else {
        ctx.clearRect(0, 0, frameWidth, frameHeight);
      }
    },
  },
  video: {
    defaultSpace: 'zoomed',
    render: ({ ctx, videoLayout, config, source, zoomScale }) => {
      drawVideoLayer(ctx, videoLayout, config.video, source, zoomScale);
    },
  },
  cursor: {
    defaultSpace: 'zoomed',
    render: ({ ctx, t, videoLayout, config }) => {
      drawCursorLayer(ctx, t, videoLayout, config.cursor);
    },
  },
  webcam: {
    defaultSpace: 'base',
    render: ({
      ctx,
      frameWidth,
      frameHeight,
      t,
      config,
      webcamSource,
      activeWebcamHeightRatio,
      activeWebcamFullScreenProgress,
    }) => {
      if (config.webcam?.enabled && webcamSource && !isInCutRegion(t * 1000, config.webcamCuts)) {
        drawWebcamLayer(
          ctx,
          frameWidth,
          frameHeight,
          config.webcam,
          webcamSource,
          activeWebcamHeightRatio,
          activeWebcamFullScreenProgress,
        );
      }
    },
  },
};

const DEFAULT_LAYER_ORDER: ReadonlyArray<CompositionLayerId> = [
  'background',
  'video',
  'cursor',
  'webcam',
];

const DEFAULT_LAYER_STATES: ReadonlyArray<ResolvedLayerState> = DEFAULT_LAYER_ORDER.map((id) => ({
  id,
  space: LAYER_DEFINITIONS[id].defaultSpace,
}));

const VALID_LAYER_IDS = new Set<CompositionLayerId>(DEFAULT_LAYER_ORDER);

const VALID_LAYER_SPACES = new Set<CompositionLayerSpace>(['base', 'zoomed']);

function resolveLayerStates(
  layerStates: CompositionLayerState[] | undefined,
): ResolvedLayerState[] {
  if (!Array.isArray(layerStates) || layerStates.length === 0) {
    return [...DEFAULT_LAYER_STATES];
  }

  const resolved: ResolvedLayerState[] = [];
  const seen = new Set<CompositionLayerId>();

  for (const layerState of layerStates) {
    if (!layerState || !VALID_LAYER_IDS.has(layerState.id)) {
      continue;
    }

    if (seen.has(layerState.id)) {
      continue;
    }

    const fallbackSpace = LAYER_DEFINITIONS[layerState.id].defaultSpace;
    const space =
      layerState.space && VALID_LAYER_SPACES.has(layerState.space)
        ? layerState.space
        : fallbackSpace;

    seen.add(layerState.id);
    resolved.push({ id: layerState.id, space });
  }

  for (const defaultLayerState of DEFAULT_LAYER_STATES) {
    if (!seen.has(defaultLayerState.id)) {
      resolved.push(defaultLayerState);
    }
  }

  return resolved;
}

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
  const videoLayout = computeVideoLayout(frameWidth, frameHeight, config);
  const zoomState = computeZoomStateFromConfig(t, config, frameWidth, frameHeight, videoLayout);
  const layerStates = resolveLayerStates(config.layerStates);

  // Resolve per-region webcam height override from webcam-source regions.
  const activeWebcamHeightRatio =
    config.webcam && config.webcamZoomRegions && config.webcamZoomRegions.length > 0
      ? computeActiveWebcamHeightRatio(
          t * 1000,
          config.webcamZoomRegions,
          config.webcam.heightRatio,
        )
      : undefined;
  const activeWebcamFullScreenProgress =
    config.webcamZoomRegions && config.webcamZoomRegions.length > 0
      ? computeActiveWebcamFullScreenProgress(t * 1000, config.webcamZoomRegions)
      : 0;

  const layerRenderContext: LayerRenderContext = {
    ctx,
    frameWidth,
    frameHeight,
    t,
    config,
    source,
    webcamSource,
    videoLayout,
    zoomScale: zoomState.scale,
    activeWebcamHeightRatio,
    activeWebcamFullScreenProgress,
  };

  let activeSpace: CompositionLayerSpace = 'base';
  let hasZoomTransform = false;

  const transitionToSpace = (nextSpace: CompositionLayerSpace) => {
    if (activeSpace === nextSpace) {
      return;
    }

    if (activeSpace === 'zoomed') {
      ctx.restore();
      hasZoomTransform = false;
    }

    if (nextSpace === 'zoomed') {
      ctx.save();
      ctx.translate(zoomState.pivotX, zoomState.pivotY);
      ctx.scale(zoomState.scale, zoomState.scale);
      ctx.translate(-zoomState.pivotX, -zoomState.pivotY);
      hasZoomTransform = true;
    }

    activeSpace = nextSpace;
  };

  const renderLayer = (layerId: CompositionLayerId) => {
    LAYER_DEFINITIONS[layerId].render(layerRenderContext);
  };

  for (const layerState of layerStates) {
    transitionToSpace(layerState.space);
    renderLayer(layerState.id);
  }

  if (hasZoomTransform) {
    ctx.restore();
  }
}
