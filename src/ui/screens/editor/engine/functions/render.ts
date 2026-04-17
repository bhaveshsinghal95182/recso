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
import { computeVideoLayout } from './layout';
import { drawVideoLayer, drawWebcamLayer } from './video-layers';
import { computeZoomStateFromConfig } from './zoom';

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
    render: ({ ctx, videoLayout, config, source }) => {
      drawVideoLayer(ctx, videoLayout, config.video, source);
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
    render: ({ ctx, frameWidth, frameHeight, config, webcamSource }) => {
      if (config.webcam?.enabled && webcamSource) {
        drawWebcamLayer(ctx, frameWidth, frameHeight, config.webcam, webcamSource);
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
  const zoomState = computeZoomStateFromConfig(t, config, frameWidth, frameHeight);
  const videoLayout = computeVideoLayout(frameWidth, frameHeight, config);
  const layerStates = resolveLayerStates(config.layerStates);
  const layerRenderContext: LayerRenderContext = {
    ctx,
    frameWidth,
    frameHeight,
    t,
    config,
    source,
    webcamSource,
    videoLayout,
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
