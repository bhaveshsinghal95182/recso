# Engine Preview Config Mapping

This folder contains the preview-only config mapping pipeline used by
`useEnginePreviewConfigMapper`.

## Modules

1. `layout.ts`
   - Canvas size retrieval from compositor
   - Backend layout/webcam-layout loading
   - Deterministic fallback layout math

2. `composition.ts`
   - Project/timeline state to `CompositionConfig` mapping
   - Webcam style normalization
   - Legacy zoom fallback mapping

3. `assets.ts`
   - Source URL mapping (`videoSrc`, `webcamSrc`, `backgroundImageSrc`)
   - Background presentation mapping (pattern + container style)

4. `types.ts`
   - Shared preview mapper output and canvas-size types

## Mapper Hook

`preview-config-mapper.ts` is now orchestration-only and composes these modules.
