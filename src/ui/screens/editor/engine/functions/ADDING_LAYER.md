# Adding a New Render Layer

This guide explains how to add a new layer to the composition renderer and how to control its order and render space.

The current renderer is data-driven:

- Layer types are defined in `types.ts`.
- Layer behavior and defaults are defined in `render.ts`.
- Default project-level order is defined in `config.ts`.
- Runtime order can be overridden with `config.layerStates`.

## Current Model (Quick Mental Map)

1. `render.ts` keeps a `LAYER_DEFINITIONS` registry.
2. Each layer definition has:
   - `defaultSpace`: where it renders (`base` or `zoomed`)
   - `render(context)`: how it draws
3. A state machine (`transitionToSpace`) switches between spaces while iterating ordered layer states.
4. `resolveLayerStates` validates and fills missing layers from defaults.

## Spaces

- `base`: no zoom transform applied.
- `zoomed`: zoom transform is applied before draw.

Use `base` for overlays that should stay fixed relative to the frame (for example webcam overlay, safe area overlays, static branding).

Use `zoomed` for content that should move/scale with zoom (for example main video, cursor tied to source video).

## Step-by-Step: Add a Layer

Example layer name below: `annotations`.

### 1) Extend layer type(s)

File: `src/ui/screens/editor/engine/types.ts`

Update `CompositionLayerId`:

```ts
export type CompositionLayerId = 'background' | 'video' | 'cursor' | 'webcam' | 'annotations';
```

If the layer needs config, add a new config interface and field on `CompositionConfig`:

```ts
export interface AnnotationsConfig {
  enabled: boolean;
  // other fields...
}

export interface CompositionConfig {
  // existing fields...
  annotations?: AnnotationsConfig;
}
```

### 2) Implement drawing helper (optional but recommended)

Create a focused function in `functions/` (for example `annotations.ts`) so `render.ts` remains orchestration-only.

### 3) Register layer in renderer

File: `src/ui/screens/editor/engine/functions/render.ts`

Add the layer in `LAYER_DEFINITIONS`:

```ts
annotations: {
  defaultSpace: 'base',
  render: ({ ctx, frameWidth, frameHeight, config }) => {
    if (!config.annotations?.enabled) {
      return;
    }
    drawAnnotationsLayer(ctx, frameWidth, frameHeight, config.annotations);
  },
},
```

Then include it in `DEFAULT_LAYER_ORDER`:

```ts
const DEFAULT_LAYER_ORDER: ReadonlyArray<CompositionLayerId> = [
  'background',
  'video',
  'cursor',
  'webcam',
  'annotations',
];
```

### 4) Set default layer state order

File: `src/ui/screens/editor/engine/functions/config.ts`

Add a default state entry in `defaultConfig.layerStates` with desired space.

```ts
{ id: 'annotations', space: 'base' }
```

### 5) (Optional) Override order per pipeline

If preview and export should use different ordering, set `layerStates` explicitly in:

- `src/ui/screens/editor/engine/preview-config/composition.ts`
- `src/ui/screens/editor/engine/export-pipeline/composition-config.ts`

## Reordering Existing Layers

You do not need renderer code changes to reorder existing layers.

Only update `layerStates`, for example:

```ts
layerStates: [
  { id: 'background', space: 'base' },
  { id: 'video', space: 'zoomed' },
  { id: 'webcam', space: 'base' },
  { id: 'cursor', space: 'zoomed' },
];
```

## Recommended Rules (Avoid Future Pain)

1. Keep layer renderers pure: do not mutate global state.
2. Keep expensive preprocessing outside frame render loops where possible.
3. Add one layer at a time and verify in both preview and export pipelines.
4. Use `defaultSpace` as the single source of truth for fallback behavior.
5. Keep `DEFAULT_LAYER_ORDER` complete so missing runtime states are safely filled.

## Minimal Validation Checklist

After adding a layer:

1. Typecheck / lint passes.
2. Layer appears in preview.
3. Layer appears in export.
4. Zoom behavior matches the selected space (`base` vs `zoomed`).
5. Reordering via `layerStates` behaves as expected.
