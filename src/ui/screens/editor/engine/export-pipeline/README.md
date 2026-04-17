# Engine Export Pipeline

This folder contains the staged export pipeline used by `runEngineCanvasExport`.

## Stage Boundaries

1. Source resolution
   - File: `source-paths.ts`
   - Responsibility: normalize source paths (`toFileUrl`), resolve webcam source fallback path.

2. Output + encoding settings
   - File: `settings.ts`
   - Responsibility: output dimensions and bitrate policy from export config.

3. Layout resolution
   - File: `layout-resolver.ts`
   - Responsibility: compositor layout lookups with deterministic fallback layout math.

4. Background precomposition
   - File: `background-layer.ts`
   - Responsibility: build one static background layer (color/pattern/image) before frame processing.

5. Composition/effects mapping
   - File: `composition-config.ts`
   - Responsibility: map project state into `CompositionConfig` used by `CompositionEngine`.

6. Webcam frame source prep
   - File: `webcam-source.ts`
   - Responsibility: decode webcam frames in timestamp order and expose a frame source.

7. Video/audio conversion
   - File: `conversion.ts`
   - Responsibility: drive Mediabunny conversion, apply timeline cuts and render each frame.

8. Webcam audio remux/mix
   - File: `webcam-audio.ts`
   - Responsibility: map webcam audio through cut timeline and merge into exported output.

9. Orchestration
   - File: `run-engine-canvas-export.ts`
   - Responsibility: wire all stages, cancellation, and progress reporting.

## Effect Order (Per Video Sample)

1. Skip sample if source timestamp is inside a cut region.
2. Map source timestamp to composition timestamp (cut-aware timeline).
3. Start frame with precomposed background layer (if present).
4. Sync webcam frame source to source timestamp.
5. Render composition frame through `CompositionEngine`.
   - Video placement/layout
   - Zoom regions / legacy zoom fallback
   - Cursor effects (style, click animation, motion blur)
   - Webcam overlay (layout, opacity, border radius, border, shadows)

## Preview vs Export Concerns

- Preview mapping remains in `preview-config-mapper.ts`.
- Export mapping is isolated in this folder.
- Shared defaults/path normalization are reused by preview and export so behavior stays aligned.
