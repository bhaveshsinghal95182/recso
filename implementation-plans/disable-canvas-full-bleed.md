# Disable Canvas (Full-Bleed Video) Implementation Plan

## 1. Goal

Implement a true "disable canvas background" mode with this behavior:

1. Output/preview canvas resolution stays the selected/default resolution (for example 1920x1080).
2. Main video always fills the entire canvas in this mode.
3. No letterboxing/padding/frame treatment on main video (no border radius, no border, no framed look).
4. Webcam remains an overlay rendered above the main video.
5. Preview and export must match.

## 2. Why This Must Land Before Crop

Crop introduces another coordinate transform. If crop is implemented on top of the current framed-layout assumptions and then full-bleed mode is added later, mouse/focal/zoom math will be rewritten twice.

Stabilizing this full-bleed mode first creates a predictable base coordinate space for:

- cursor event mapping,
- zoom focal points,
- webcam anchor layout,
- preview/export parity.

## 3. Scope

### In Scope

- New/clear mode semantics for "canvas background disabled".
- Layout math update for full-bleed placement in disabled mode.
- Preview and export parity.
- Mouse/cursor/focal interaction correctness under full-bleed.

### Out of Scope

- User-facing crop controls.
- New background styles.
- Resolution system redesign.

## 4. Current Problem Summary

Current behavior is split across color/path/pattern rules and layout defaults:

- Toggle off is inferred from backgroundColor === "transparent".
- Image/path and pattern layers are independently resolved and can remain visible.
- Layout calculations still use framed fit math (padding + maxScale) unless overridden.

Result: "background disabled" does not reliably mean "video fills full canvas with no framing".

## 5. Proposed Behavioral Contract

Introduce one explicit source of truth in project state:

- canvasBackgroundEnabled: boolean

Rules:

- canvasBackgroundEnabled = true
  - existing framed behavior (background, fit layout, framed styling) remains.
- canvasBackgroundEnabled = false
  - no background paint,
  - layout forced to full canvas,
  - main video style forced to edge-to-edge (no frame treatment),
  - webcam overlay still active.

Backward compatibility:

- Older project.json files without this field default to true.

## 6. Files and Functions To Touch

### 6.1 UI State and Toggle Semantics

1. src/ui/screens/editor/panels/general-panel.tsx
   - isBackgroundEnabled (line around current toggle logic)
   - handleBackgroundToggle
   - behavior for color/pattern/image controls when disabled

2. src/ui/store/project-store.ts
   - updateBackgroundColor
   - updateBackgroundPath
   - updateBackgroundPattern
   - add action to update canvasBackgroundEnabled

3. src/ui/types.ts
   - Project interface: add canvasBackgroundEnabled

4. src/electron/types/project.types.ts
   - Project interface: add canvasBackgroundEnabled

### 6.2 IPC and Main Process Persistence

1. src/electron/ipc/background.ipc.ts
   - background:get-config response shape should include canvasBackgroundEnabled
   - add/update handler to persist enable/disable mode explicitly

2. src/electron/services/editor.service.ts
   - createProject default initialization
   - loadProject normalization for old projects (default true)
   - persistence methods when mode changes
   - sync compositor state on load

3. src/ui/electron.d.ts
   - renderer API contract update for new flag

4. src/electron/preload.cts
   - expose new IPC bridge function(s)

### 6.3 Layout Resolution (Core Full-Bleed Math)

1. src/electron/services/compositor.service.ts
   - calculateLayout must support two modes:
     - framed (existing)
     - full-bleed (x=0, y=0, width=canvasW, height=canvasH, scale=1)

2. src/ui/screens/editor/engine/preview-config/layout.ts
   - loadPreviewLayoutSnapshot should request mode-aware layout
   - calculateFallbackLayout must support full-bleed fallback

3. src/ui/screens/editor/engine/export-pipeline/layout-resolver.ts
   - resolveLayout should request mode-aware layout
   - fallback layout must support full-bleed mode

4. src/electron/types/compositor.types.ts
   - layout request/result contract extension if needed

### 6.4 Preview Mapping and Rendering

1. src/ui/screens/editor/engine/preview-config/assets.ts
   - getPreviewBackgroundPresentation should honor canvasBackgroundEnabled
   - ensure hasPattern/background container style is suppressed in disabled mode

2. src/ui/screens/editor/engine/preview-config-mapper.ts
   - pass mode into layout and composition mapping
   - return derived metadata for preview rendering

3. src/ui/screens/editor/engine/preview.tsx
   - skip background DOM layer entirely when disabled
   - maintain canvas display size logic while using full-bleed layout

4. src/ui/screens/editor/engine/preview-runtime/display.ts
   - overlay layout remains valid but must consume full-bleed layout values

### 6.5 Engine Composition Config

1. src/ui/screens/editor/engine/preview-config/composition.ts
   - buildPreviewCompositionConfig:
     - layout forced full-canvas in disabled mode
     - video border/borderRadius/frame styling removed in disabled mode

2. src/ui/screens/editor/engine/export-pipeline/composition-config.ts
   - buildExportCompositionConfig:
     - same style/layout behavior as preview
     - do not depend on transparent-color hacks for mode

3. src/ui/screens/editor/engine/export-pipeline/defaults.ts
   - framed style defaults can remain, but mode-specific overrides are required

### 6.6 Render Path and Interaction Math

1. src/ui/screens/editor/engine/functions/render.ts
   - background layer behavior should follow mode contract

2. src/ui/screens/editor/engine/functions/layout.ts
   - computeVideoLayout should consume explicit full-bleed layout cleanly

3. src/ui/screens/editor/engine/functions/video-layers.ts
   - ensure no frame treatment in disabled mode

4. src/ui/screens/editor/engine/functions/cursor.ts
   - verify mapping path that uses layout.scale/content rect
   - in full-bleed mode cursor mapping should align exactly with full canvas

5. src/ui/screens/editor/focal-point-overlay.tsx
   - drag clamp and normalization must match full-bleed video rectangle

6. src/ui/screens/editor/engine/functions/zoom.ts
   - verify pivot interpretation against full-canvas video area

### 6.7 Export Orchestration and Background Layering

1. src/ui/screens/editor/engine/export-pipeline/run-engine-canvas-export.ts
   - pass mode into layout and composition config builders

2. src/ui/screens/editor/engine/export-pipeline/background-layer.ts
   - hard-skip static background layer construction in disabled mode

3. src/ui/screens/editor/engine/export-pipeline/conversion.ts
   - existing behavior OK if backgroundLayer is null, but parity verification required

4. src/ui/screens/editor/export-modal.tsx
   - no new feature required, but ensure config does not reintroduce color-based mode assumptions

### 6.8 Legacy/Reference FFmpeg Filters (Optional but Recommended)

1. src/electron/services/exporter/filters/background-filter.ts
2. src/electron/services/exporter/filters/zoom-filter.ts
3. src/electron/services/exporter/filters/index.ts

These are currently not primary for engine-canvas export, but should be updated (or clearly documented) to avoid future confusion.

## 7. What Must Be Reimplemented

### 7.1 Disable Canvas Mode Semantics

Reimplement from implicit color state to explicit mode state:

- Replace "transparent means disabled" as the authoritative rule.
- Keep color/path/pattern as content choices only when mode is enabled.

### 7.2 Layout Strategy

Reimplement layout decision as:

- if canvasBackgroundEnabled: framed fit strategy (current)
- else: full-bleed strategy

Full-bleed strategy returns:

- x = 0
- y = 0
- width = canvasWidth
- height = canvasHeight
- scale = 1

### 7.3 Main Video Styling Strategy

Reimplement style application to be mode-aware:

- framed mode: current border radius/border behavior
- disabled mode: no border, no border radius, no framing treatment

### 7.4 Background Rendering Strategy

Reimplement both preview and export to skip background rendering when disabled:

- no DOM background layer in preview,
- no static background precomposition layer in export,
- no fallback color fill except where required by technical clear operations.

### 7.5 Cursor and Point Mapping Safety

Reimplement/verify cursor draw mapping under full-bleed:

- normalized points should map directly to full canvas video area,
- click rings and motion blur should be centered on the same transformed point,
- no offset from old framed content rect assumptions.

### 7.6 Focal-Point Editing Safety

Reimplement/verify focal interaction bounds so draggable focal point uses the full video region and clamps consistently.

## 8. Risks and Mitigations

### Risk 1: Cursor Offsets (Highest Risk)

Symptoms:

- cursor appears shifted from expected position,
- click feedback rendered away from pointer.

Mitigation:

- targeted tests at corners and center,
- compare preview frame captures against export frames.

### Risk 2: Preview/Export Mismatch

Symptoms:

- preview looks full-bleed but export still letterboxes,
- webcam position drift between preview and export.

Mitigation:

- enforce shared mode + layout contract across preview/export mappers,
- golden-frame parity checks.

### Risk 3: Legacy Project Compatibility

Symptoms:

- old projects unexpectedly open in disabled mode.

Mitigation:

- default missing field to true during load normalization.

## 9. Validation Matrix

### Manual Cases

1. 16:9 source to 16:9 canvas, mode disabled
   - full fill, no framing
2. 4:3 source to 16:9 canvas, mode disabled
   - full canvas occupation per contract (stretch/strategy must be explicit and consistent)
3. 9:16 source to 16:9 canvas, mode disabled
4. Cursor-only project with many clicks and fast motion
5. Zoom region with focal keyframes
6. Webcam overlay enabled with each anchor
7. Toggle mode on/off multiple times in one session
8. Export and compare key frames vs preview

### Automated/Programmatic Checks

1. Layout function unit tests:
   - framed vs full-bleed outputs
2. Mapper snapshot tests:
   - composition config in both modes
3. Cursor mapping tests:
   - normalized points at 0,0; 0.5,0.5; 1,1
4. Export parity test:
   - same timestamp frame in preview vs exported output

## 10. Suggested Implementation Order

1. Add explicit mode field to project types and persistence.
2. Update UI toggle to write/read explicit mode.
3. Add mode-aware layout in compositor + fallback resolvers.
4. Update preview mapping/rendering to suppress backgrounds and use full-bleed.
5. Update composition builders for mode-aware video styling.
6. Verify/fix cursor and focal mapping.
7. Update export background precompose behavior.
8. Run parity and regression validation.

## 11. Definition of Done

1. Disabling canvas background always results in full-canvas main video.
2. No background image/color/pattern is rendered in disabled mode.
3. Main video has no frame treatment in disabled mode.
4. Webcam remains correctly overlaid on top.
5. Cursor/click/motion blur aligns correctly across the frame.
6. Focal-point editing works with no dead zones or offset.
7. Preview and export match for sampled timestamps.
8. Existing projects load with expected behavior (compatible defaults).

## 12. Notes for Future Crop Work

After this lands, crop can be built on a cleaner model:

- First transform: source -> crop rect
- Second transform: crop output -> canvas layout

Because full-bleed mode is explicit and stable, crop integration can branch predictably by mode without rewriting base cursor/focal assumptions.
