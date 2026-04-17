# Engine Preview Runtime

This folder contains preview-runtime concerns extracted from `preview.tsx`.

## Modules

1. `viewport.ts`
   - Viewport size observation through `ResizeObserver`.

2. `display.ts`
   - Preview display scaling and overlay layout projection.

3. `video-time.ts`
   - Shared video time clamp/sync utilities.

4. `rendering.ts`
   - Safe frame render helper with one-time error logging behavior.

5. `playback.ts`
   - Play/pause transport synchronization and paused seek synchronization.

6. `session.ts`
   - Preview session lifecycle: initialization, RAF render loop, and cleanup.

## Orchestration

`preview.tsx` now focuses on wiring project state, mapper output, and UI rendering while delegating runtime mechanics to this folder.
