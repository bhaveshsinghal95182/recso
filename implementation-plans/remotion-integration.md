# Remotion Integration Implementation Plan

## Comprehensive Guide with Detailed Explanations

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [Why Remotion?](#why-remotion)
4. [Phase-by-Phase Implementation](#phase-by-phase-implementation)
5. [Technical Deep Dives](#technical-deep-dives)
6. [Testing Strategy](#testing-strategy)
7. [Troubleshooting Guide](#troubleshooting-guide)

---

## Executive Summary

### What We're Building

We're integrating Remotion as a **compositor layer** into the existing video export pipeline. This means Remotion will handle all visual effects (background, zoom, cursor animations) and produce an intermediate video file, which FFmpeg will then process for cuts and upscaling.

### What We're NOT Changing

- **UI/Editor**: The entire frontend editor remains unchanged. Users continue to edit in the same interface.
- **Project Structure**: The existing `Project` data structure stays the same.
- **Configuration Files**: No new config files needed. Everything reads from your existing project data.
- **Developer Experience**: No new build processes or tooling required beyond Remotion's npm packages.

### The Goal

Replace the current FFmpeg-only rendering pipeline that struggles with complex effects with a two-stage pipeline:

1. **Remotion Stage**: Render all visual effects programmatically with React components
2. **FFmpeg Stage**: Apply cuts and upscaling only

### Expected Benefits

- **Better Quality**: React-based rendering produces smoother animations and better visual fidelity
- **More Control**: Complex effects become easier to implement and maintain
- **Future-Proof**: Opens door for advanced features like transitions, text overlays, and complex animations
- **Maintainability**: Effect logic in React is easier to understand and modify than FFmpeg filter strings

---

## Architecture Overview

### Current Architecture (FFmpeg-Only)

```
┌─────────────────────────────────────────────────────────────┐
│                      User Edits Project                      │
│                  (UI - Remains Unchanged)                    │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    Export Triggered                          │
│              (exporter.service.ts)                           │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                  FFmpeg Pipeline                             │
│  • Apply background filter (complex overlay)                 │
│  • Apply zoom filter (scale + transform)                     │
│  • Apply cut filter (select frames)                          │
│  • Apply scaling filter (upscale resolution)                 │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                   Final MP4 Output                           │
└─────────────────────────────────────────────────────────────┘
```

**Current Problems:**

1. **Complex Filter Chains**: Background + zoom requires intricate FFmpeg filter graphs that are hard to debug
2. **Limited Animation Control**: FFmpeg's interpolation is basic; smooth easing curves are difficult
3. **Maintenance Burden**: Filter strings are cryptic and error-prone
4. **Performance**: Complex filters can be slow and resource-intensive in FFmpeg
5. **Future Limitations**: Adding features like text, masks, or advanced transitions is extremely difficult

### New Architecture (Bundled Remotion)

```
┌─────────────────────────────────────────────────────────────┐
│                      User Edits Project                      │
│                  (UI - Remains Unchanged)                    │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    Export Triggered                          │
│              (exporter.service.ts)                           │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              STAGE 1: Remotion Compositor                    │
│            (remotion-renderer.service.ts)                    │
│                                                              │
│  1. Bundle React composition (cached)                        │
│  2. Resolve Bundled Chrome Path (no download needed)         │
│  3. Pass Project data as inputProps                          │
│  4. Render via `renderMedia` (Frame-Accurate)                │
│                                                              │
│  Composition Layers:                                         │
│  ├─ BackgroundLayer (solid color or image)                   │
│  ├─ VideoLayer (positioned raw video)                        │
│  ├─ ZoomEffect (animated transforms)                         │
│  └─ CursorLayer (future: mouse/click animations)             │
│                                                              │
│  Output: temp/remotion-{uuid}.mp4                            │
│  Progress: 0% → 60%                                          │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│            STAGE 2: FFmpeg Post-Processor                    │
│          (exporter.service.ts - modified)                    │
│                                                              │
│  Input: Remotion's temp file                                 │
│                                                              │
│  Filters Applied:                                            │
│  ├─ Cut filter (remove unwanted segments)                    │
│  └─ Scaling filter (upscale to target resolution)            │
│                                                              │
│  Output: exports/{filename}.mp4                              │
│  Progress: 60% → 100%                                        │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│               Final MP4 Output + Cleanup                     │
│        (temp files deleted automatically)                    │
└─────────────────────────────────────────────────────────────┘
```

**Key Improvements:**

1.  **Stability**: Uses Remotion's frame-accurate rendering pipeline (no race conditions)
2.  **Offline Ready**: Bundles Chrome executable within the app (no runtime download)
3.  **Separation of Concerns**: Visual effects handled by React, post-processing by FFmpeg
4.  **Easier Debugging**: Can preview Remotion composition independently
5.  **Maintainability**: React component code is more readable than FFmpeg filters
6.  **Extensibility**: Adding new effects is as simple as adding React components

---

## Why Remotion?

### The Problem with Pure FFmpeg

**FFmpeg is excellent for:**

- Video codec operations (encoding, decoding, format conversion)
- Simple filters (scaling, cropping, color adjustments)
- Stream manipulation (cutting, concatenating, extracting audio)
- Low-level pixel operations

**FFmpeg struggles with:**

- **Complex Animations**: Smooth easing, bezier curves, spring animations
- **Layering**: Multiple overlays with dynamic positioning
- **Conditional Logic**: Showing/hiding elements based on time or data
- **Interactive Effects**: Mouse tracking, click animations that need frame-by-frame precision
- **Maintainability**: Filter strings like `[0:v][1:v]overlay=x='if(between(t,5,10),W*(t-5)/5,W)':y=0` are hard to read

**Example: Current Zoom Filter Challenge**

Our current zoom filter implementation:

```typescript
// zoom-filter.ts
const zoomFilter = `zoompan=z='if(between(t,${startSec},${endSec}),
  lerp(1,${zoomLevel},(t-${startSec})/(${endSec}-${startSec})),1)':
  x='${focalX}-(iw*zoom/2)':y='${focalY}-(ih*zoom/2)':d=1:s=${width}x${height}`;
```

**Problems:**

1. **No easing**: Linear interpolation only (`lerp`). No ease-in/ease-out
2. **String concatenation**: Easy to make syntax errors
3. **No preview**: Must render entire video to see if it works
4. **Fragile**: Changing zoom logic requires understanding FFmpeg expression syntax

**Same Feature in Remotion:**

```typescript
// ZoomEffect.tsx
const zoomLevel = interpolate(
  progress,
  [0, 0.2, 0.8, 1],              // Keyframes
  [1, targetZoom, targetZoom, 1], // Values
  { easing: Easing.bezier(0.25, 0.1, 0.25, 1) } // Smooth easing
);

return (
  <div style={{
    transform: `scale(${zoomLevel})`,
    transformOrigin: `${focalX}px ${focalY}px`
  }}>
    {children}
  </div>
);
```

**Benefits:**

1. ✅ **Smooth Easing**: Bezier curves, spring animations, custom easing functions
2. ✅ **Readable Code**: Standard React and CSS transforms
3. ✅ **Live Preview**: Can preview with `remotion preview` command
4. ✅ **Type Safety**: TypeScript ensures correct props and values
5. ✅ **Hot Reload**: Changes reflect immediately in preview
6. ✅ **Debugging**: Can use React DevTools, console.log, breakpoints

### Why Not Replace FFmpeg Entirely?

**FFmpeg's Strengths:**

- **Cutting**: The `select` filter is perfect for removing segments without re-encoding gaps
- **Codec Optimization**: FFmpeg has the best H.264/H.265 encoders with hardware acceleration
- **Upscaling**: High-quality scaling algorithms (Lanczos, bicubic) are built-in
- **Performance**: For simple operations, FFmpeg is extremely fast
- **Reliability**: Battle-tested for 20+ years, handles edge cases well

**Remotion's Strengths:**

- **Visual Composition**: Layering, animations, effects
- **Developer Experience**: React familiarity, hot reload, live preview
- **Complex Logic**: Conditional rendering, data-driven animations
- **Extensibility**: Easy to add libraries (Three.js, D3, Canvas API)

**The Hybrid Approach:**
Use each tool for what it does best:

- **Remotion**: Compose the visual output (render frames with effects)
- **FFmpeg**: Post-process the video (cut unwanted parts, upscale resolution)

This gives us the best of both worlds while minimizing complexity.

### Chrome Resolution via `chrome-resolver.service.ts`

Rather than bundling a Chrome executable at build time, we use Remotion's built-in `ensureBrowser()` API via our `chrome-resolver.service.ts`:

**How It Works:**

1. **First Export**: `ensureBrowser()` downloads the correct Chrome version (~150-200MB) and caches it.
2. **Subsequent Exports**: Returns the cached path instantly (no re-download).
3. **Version Matching**: Remotion handles pinning the correct Chrome version internally.

**Why This Approach:**

- **Stability**: Uses Remotion's proven, frame-accurate rendering pipeline (`renderMedia`).
- **Zero Configuration**: Users don't need to install Chrome or set environment variables.
- **Predictable**: Remotion controls the exact version of Chrome used.
- **Simpler Build**: No `postinstall` script or `extraResources` config needed.
- **Smaller Initial Install**: Chrome is downloaded on demand, not bundled in the installer.

**Trade-off**: Requires internet on first export. Subsequent exports use the cached Chrome.

**For our use case**, this trade-off is worth it because:

- Exports are infrequent (users export once after editing, not continuously)
- Quality and maintainability matter more than raw speed
- The extra 30-60 seconds for a better result is acceptable

---

## Phase-by-Phase Implementation

### Phase 1: Dependencies Setup

**Duration**: 30 minutes  
**Complexity**: Low  
**Risk**: Low

#### What We're Installing

**Core Remotion Packages:**

```bash
pnpm add @remotion/renderer @remotion/bundler remotion
```

- **`remotion`**: Core library with React components (`<Video>`, `<AbsoluteFill>`, `interpolate()`, etc.)
- **`@remotion/bundler`**: Webpack-based bundler that packages your composition for rendering
- **`@remotion/renderer`**: Node.js API for programmatic rendering (what we'll use in Electron)

**Why These Three:**

- `remotion`: Needed for writing compositions (the React components)
- `@remotion/bundler`: Bundles compositions into a format Puppeteer can load
- `@remotion/renderer`: Provides `renderMedia()` function to render programmatically

**Puppeteer:**

```bash
pnpm add puppeteer
```

**Chrome Resolution (Already Implemented):**

Chrome is resolved at runtime via `chrome-resolver.service.ts`, which uses Remotion's `ensureBrowser()` API. No `postinstall` script or `electron-builder` `extraResources` config is needed.

**File**: `src/electron/services/chrome-resolver.service.ts` ✅ (already exists)

```typescript
import { ensureBrowser } from '@remotion/renderer';

let cachedChromePath: string | null = null;

export async function ensureChromeBrowser(): Promise<string> {
  if (cachedChromePath) return cachedChromePath;
  const status = await ensureBrowser({ logLevel: 'info' });
  if (status.type === 'no-browser' || status.type === 'version-mismatch') {
    throw new Error(`Failed to ensure Chrome browser. Status: ${status.type}`);
  }
  cachedChromePath = status.path;
  return cachedChromePath;
}
```

**React Dependencies:**

```bash
pnpm add react react-dom
```

- **Why**: Remotion compositions are React components
- **Note**: You likely already have these for your UI, so they'll be shared

#### Why No Config Files?

Traditional Remotion projects have a `remotion.config.ts` file that specifies:

```typescript
// NOT doing this ❌
export default {
  compositions: [
    {
      id: 'main',
      component: MainComposition,
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: 300,
    },
  ],
};
```

**We're skipping this because:**

1. **Dynamic Values**: Your video dimensions, duration, and FPS change per export
2. **Data-Driven**: Everything comes from the `Project` object at runtime
3. **Programmatic Rendering**: We're using `@remotion/renderer` API directly, not the CLI
4. **Simpler Setup**: One less file to maintain and keep in sync

**Instead, we'll:**

- Register compositions programmatically in `src/remotion/index.ts`
- Pass all values as `inputProps` at render time
- Calculate dimensions/duration in the service layer

This keeps everything centralized in your existing architecture.

#### Development Script (Optional)

```json
// package.json
{
  "scripts": {
    "remotion:preview": "remotion preview src/remotion/index.ts --props '{\"project\":{...}}'"
  }
}
```

**Purpose**: Preview your composition in a browser during development
**Usage**: Helpful for debugging, but not required for the integration to work
**Trade-off**: Requires manually constructing sample `inputProps` JSON

---

### Phase 2: Remotion Composition Layer

**Duration**: 3-4 hours  
**Complexity**: Medium  
**Risk**: Low

#### Overview: What Is a Composition?

A Remotion "composition" is a React component that represents one frame of your video. Remotion calls this component many times (once per frame) with different `frame` values to render the entire video.

**Mental Model:**

```typescript
// Remotion essentially does this:
for (let frame = 0; frame < totalFrames; frame++) {
  const screenshot = await renderComponent(<YourComposition />, { frame });
  videoFrames.push(screenshot);
}
```

Your React component uses the `frame` prop to determine what to show:

```typescript
const frame = useCurrentFrame(); // 0, 1, 2, 3, ...
const { fps } = useVideoConfig(); // 30
const timeInSeconds = frame / fps; // 0, 0.033, 0.066, ...
```

#### File Structure Explained

```
src/remotion/
  ├── index.ts                    # Entry point (registers compositions)
  ├── types.ts                    # Input props interface
  ├── Composition.tsx              # Main composition (orchestrates layers)
  ├── BackgroundLayer.tsx          # Renders background
  ├── VideoLayer.tsx               # Renders source video
  └── ZoomEffect.tsx               # Applies zoom animation
```

**Why This Structure:**

- **Separation of Concerns**: Each layer is independent and reusable
- **Testability**: Can test/preview each layer in isolation
- **Maintainability**: Adding new effects is as simple as adding a new file
- **Performance**: Can optimize individual layers without affecting others

#### Step 2.1: Input Props Interface

**File**: `src/remotion/types.ts`

```typescript
import type { Project } from '../electron/types/project.types';
import type { ExportConfig } from '../electron/types/exporter.types';

/**
 * Props passed to Remotion composition at render time.
 *
 * This is the contract between your Electron backend and Remotion.
 * Everything the composition needs to render must be included here.
 */
export interface RemotionInputProps {
  /**
   * The complete project data structure.
   * Contains all user edits: cuts, zoom regions, cursor config, etc.
   */
  project: Project;

  /**
   * Export configuration from the Export dialog.
   * Contains: resolution, format, quality, fps.
   */
  config: ExportConfig;

  /**
   * Pre-calculated layout from compositor.service.
   *
   * Why pre-calculate?
   * - Compositor service has the logic for centering/padding
   * - Keeps layout calculations in one place
   * - Avoids duplicating logic in Remotion
   */
  layout: {
    /** X position of video on canvas (in pixels) */
    videoX: number;
    /** Y position of video on canvas (in pixels) */
    videoY: number;
    /** Scaled width of video (in pixels) */
    videoWidth: number;
    /** Scaled height of video (in pixels) */
    videoHeight: number;
    /** Total canvas width (in pixels) */
    canvasWidth: number;
    /** Total canvas height (in pixels) */
    canvasHeight: number;
  };
}
```

**Why This Interface:**

1. **Type Safety**: TypeScript ensures backend and frontend stay in sync
2. **Single Source of Truth**: Project structure is already defined
3. **Pre-calculated Layout**: Reuses existing compositor logic
4. **Complete Data**: Everything needed for rendering is explicitly listed

**What About Video File Paths?**

- `project.rawVideoPath` contains the absolute path to the source video
- Remotion's `<Video>` component accepts local file paths
- No need to serve files over HTTP; Puppeteer can access local files

#### Step 2.2: Background Layer

**File**: `src/remotion/BackgroundLayer.tsx`

```typescript
import React from 'react';
import { Img } from 'remotion';
import type { RemotionInputProps } from './types';

/**
 * BackgroundLayer: Renders the canvas background.
 *
 * Supports:
 * - Solid color (from project.backgroundColor)
 * - Image (from project.backgroundPath)
 *
 * This replaces the background-filter.ts FFmpeg filter.
 */
export const BackgroundLayer: React.FC<RemotionInputProps> = ({ project, layout }) => {
  const { backgroundPath, backgroundColor } = project;

  // Case 1: Image background
  if (backgroundPath) {
    return (
      <Img
        src={backgroundPath}
        style={{
          width: layout.canvasWidth,
          height: layout.canvasHeight,
          objectFit: 'cover', // Fill canvas, crop if needed
        }}
      />
    );
  }

  // Case 2: Solid color background
  return (
    <div
      style={{
        width: layout.canvasWidth,
        height: layout.canvasHeight,
        backgroundColor: backgroundColor || '#1a1a2e', // Fallback color
      }}
    />
  );
};
```

**Why This Approach:**

**Remotion's `<Img>` vs `<img>`:**

- `<Img>` waits for image to load before rendering frame
- Prevents flashing or partially loaded images
- Essential for consistent rendering across all frames

**`objectFit: 'cover'`:**

- Ensures background fills entire canvas
- Maintains aspect ratio
- Crops if image aspect doesn't match canvas
- Same behavior as CSS `background-size: cover`

**Why Not Complex Logic:**

- Keep components simple and predictable
- Background logic is straightforward (image or color)
- More complex scenarios (gradients, patterns) can be added later

**Performance Note:**

- Static backgrounds render quickly
- Same image reused for all frames (cached by Chrome)
- No performance concerns here

#### Step 2.3: Video Layer

**File**: `src/remotion/VideoLayer.tsx`

```typescript
import React from 'react';
import { Video } from 'remotion';
import type { RemotionInputProps } from './types';

/**
 * VideoLayer: Renders the source video at calculated position.
 *
 * The layout prop tells us where to place the video on the canvas.
 * This is calculated by compositor.service using the same logic
 * as the editor preview.
 */
export const VideoLayer: React.FC<RemotionInputProps> = ({ project, layout }) => {
  return (
    <Video
      src={project.rawVideoPath}
      style={{
        position: 'absolute',
        left: layout.videoX,
        top: layout.videoY,
        width: layout.videoWidth,
        height: layout.videoHeight,
      }}
    />
  );
};
```

**Why This Is Simple:**

**No Complex Logic Needed:**

- Layout is pre-calculated by `compositor.service`
- Video positioning is just CSS (`position: absolute`)
- `<Video>` component handles playback synchronization

**Remotion's `<Video>` Component:**

```typescript
// What <Video> does internally:
// 1. Seeks to correct timestamp for current frame
// 2. Renders that exact frame
// 3. Ensures audio stays in sync (if included)
```

**Why Not Use `<video>` Element:**

- Browser `<video>` has race conditions with seeking
- Remotion's `<Video>` guarantees frame-accurate rendering
- Handles edge cases (codecs, containers, seeking bugs)

**File Path Handling:**

- `project.rawVideoPath` is absolute path (e.g., `C:/Users/.../recording.mp4`)
- Puppeteer running locally can access local files
- No need for file:// protocol or serving over HTTP

**Sync Across Frames:**
Remotion automatically syncs the video to the composition timeline:

```typescript
// Frame 0: Shows video at 0.000s
// Frame 1: Shows video at 0.033s (at 30fps)
// Frame 2: Shows video at 0.066s
// ...
```

No manual seeking required!

#### Step 2.4: Zoom Effect

**File**: `src/remotion/ZoomEffect.tsx`

```typescript
import React from 'react';
import { useCurrentFrame, useVideoConfig, interpolate, Easing } from 'remotion';
import type { RemotionInputProps } from './types';

/**
 * ZoomEffect: Applies zoom animations based on zoom regions.
 *
 * Replaces zoom-filter.ts with smooth, eased animations.
 *
 * How it works:
 * 1. Check current time against zoom regions
 * 2. If inside a zoom region, interpolate zoom level
 * 3. Apply CSS transform to children
 * 4. Use transform-origin for focal point
 */
export const ZoomEffect: React.FC<{
  children: React.ReactNode;
} & RemotionInputProps> = ({ children, project }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Convert frame number to milliseconds
  const currentTimeMs = (frame / fps) * 1000;

  // Find active zoom region (if any)
  const activeZoom = project.zoomRegions?.find(
    (region) => currentTimeMs >= region.startMs && currentTimeMs <= region.endMs
  );

  // No zoom active: render children as-is
  if (!activeZoom) {
    return <>{children}</>;
  }

  // Calculate progress through zoom region (0 to 1)
  const progress = (currentTimeMs - activeZoom.startMs) / (activeZoom.endMs - activeZoom.startMs);

  /**
   * Interpolate zoom level with easing:
   *
   * Keyframes:
   * - 0.0: progress 0% (zoom starts) → zoomLevel = 1.0 (no zoom yet)
   * - 0.2: progress 20% (ease in complete) → zoomLevel = target
   * - 0.8: progress 80% (hold zoomed) → zoomLevel = target
   * - 1.0: progress 100% (zoom ends) → zoomLevel = 1.0 (back to normal)
   *
   * This creates:
   * - 20% of time: ease into zoom
   * - 60% of time: hold at zoom level
   * - 20% of time: ease out of zoom
   */
  const zoomLevel = interpolate(
    progress,
    [0, 0.2, 0.8, 1],                           // Input range (progress points)
    [1, activeZoom.zoomLevel, activeZoom.zoomLevel, 1], // Output range (zoom values)
    {
      extrapolateLeft: 'clamp',   // Don't go below 1 before zoom starts
      extrapolateRight: 'clamp',  // Don't go below 1 after zoom ends
      easing: Easing.bezier(0.25, 0.1, 0.25, 1), // Smooth bezier curve
    }
  );

  return (
    <div
      style={{
        transform: `scale(${zoomLevel})`,
        transformOrigin: `${activeZoom.focalX}px ${activeZoom.focalY}px`,
        width: '100%',
        height: '100%',
      }}
    >
      {children}
    </div>
  );
};
```

**Deep Dive: How Interpolation Works**

**The Problem:**
You want zoom to ease in smoothly, hold, then ease out smoothly.

**Linear Interpolation (FFmpeg's lerp):**

```
Zoom Level
  ^
  |     ______
  |    /      \
  |   /        \
  |  /          \
  |_/____________\___> Time
  1.0            1.0

Sharp corners = jerky motion
```

**Remotion's Interpolation with Easing:**

```
Zoom Level
  ^
  |    _______
  |  ,'       `.
  | /           \
  |/             \
  |_______________> Time
  1.0            1.0

Smooth curves = natural motion
```

**Keyframe Example:**

```typescript
interpolate(
  progress,        // Current value
  [0, 0.2, 0.8, 1], // Input keyframes
  [1, 2.5, 2.5, 1], // Output values
  { easing: Easing.bezier(...) }
)

// When progress = 0.0 → returns 1.0 (no zoom)
// When progress = 0.1 → returns ~1.8 (easing in)
// When progress = 0.2 → returns 2.5 (fully zoomed)
// When progress = 0.5 → returns 2.5 (holding)
// When progress = 0.8 → returns 2.5 (still holding)
// When progress = 0.9 → returns ~1.8 (easing out)
// When progress = 1.0 → returns 1.0 (no zoom)
```

**Why `transformOrigin`:**
By default, `scale()` zooms from the center. `transformOrigin` lets you zoom from a specific point:

```typescript
transformOrigin: '500px 300px';
// ^ Zooms as if user clicked at (500, 300)
// The video appears to "zoom into" that point
```

**Performance:**

- CSS `transform` uses GPU acceleration
- No re-layout or repaint needed
- Extremely smooth even at high zoom levels
- Browser-native operation

#### Step 2.5: Main Composition

**File**: `src/remotion/Composition.tsx`

```typescript
import React from 'react';
import { AbsoluteFill } from 'remotion';
import { BackgroundLayer } from './BackgroundLayer';
import { VideoLayer } from './VideoLayer';
import { ZoomEffect } from './ZoomEffect';
import type { RemotionInputProps } from './types';

/**
 * MainComposition: Orchestrates all layers.
 *
 * Rendering order (bottom to top):
 * 1. Background (solid color or image)
 * 2. Video (with zoom effect applied)
 * 3. (Future) Cursor animations
 * 4. (Future) Text overlays
 *
 * Each layer is independent and can be developed/tested separately.
 */
export const MainComposition: React.FC<RemotionInputProps> = (props) => {
  return (
    <AbsoluteFill>
      {/* Layer 1: Background fills entire canvas */}
      <BackgroundLayer {...props} />

      {/* Layer 2: Video with zoom animation */}
      <ZoomEffect {...props}>
        <VideoLayer {...props} />
      </ZoomEffect>

      {/* Future layers go here */}
    </AbsoluteFill>
  );
};
```

**Why `<AbsoluteFill>`:**

Remotion's `<AbsoluteFill>` is equivalent to:

```css
position: absolute;
top: 0;
left: 0;
right: 0;
bottom: 0;
width: 100%;
height: 100%;
```

**Benefits:**

- Fills entire composition canvas
- Stacks layers on top of each other
- No margin/padding issues
- Consistent with Remotion conventions

**Layer Order Matters:**

```typescript
<AbsoluteFill>
  <Background />  {/* Renders first (bottom) */}
  <Video />       {/* Renders second (middle) */}
  <Cursor />      {/* Renders third (top) */}
</AbsoluteFill>
```

This is like Photoshop layers - bottom layer renders first, top layer renders last.

**Why Wrap Video in ZoomEffect:**

```typescript
<ZoomEffect>
  <VideoLayer />
</ZoomEffect>
```

The zoom transform applies to the entire video. If we add cursor later:

```typescript
<ZoomEffect>
  <VideoLayer />
  <CursorLayer />  {/* Cursor also zooms with video */}
</ZoomEffect>
```

This keeps video and cursor synchronized during zoom.

#### Step 2.6: Entry Point

**File**: `src/remotion/index.ts`

```typescript
import { Composition } from 'remotion';
import { MainComposition } from './Composition';

/**
 * Remotion Entry Point.
 *
 * This file is loaded by @remotion/bundler when bundling.
 * It must export a default component with <Composition> definitions.
 *
 * Note: We use minimal configuration here because all values
 * (width, height, fps, duration) are provided programmatically
 * via inputProps at render time.
 */
export default function RemotionRoot() {
  return (
    <>
      <Composition
        id="main"
        component={MainComposition}
        // These are placeholders; real values come from inputProps
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        // defaultProps are overridden at render time
        defaultProps={{
          project: {} as any,
          config: {} as any,
          layout: {} as any,
        }}
      />
    </>
  );
}

// Also export for direct import
export { MainComposition };
```

**Why This Structure:**

**`<Composition>` Component:**

- Registers a composition with Remotion's bundler
- `id="main"`: Reference this when rendering
- `component={MainComposition}`: The React component to render
- Placeholder props: Will be overridden by `inputProps` parameter

**Why Placeholder Values:**

```typescript
durationInFrames={300} // This is ignored
fps={30}               // This is ignored
width={1920}           // This is ignored
```

These are required by type definitions but are overridden when we call:

```typescript
await renderMedia({
  composition: {
    ...loadedComposition,
    durationInFrames: calculatedDuration, // Real value
    fps: config.fps, // Real value
    width: canvasWidth, // Real value
  },
  inputProps: actualProjectData, // Real data
  // ...
});
```

**Why Export Both Ways:**

```typescript
export default function RemotionRoot() { ... }
export { MainComposition };
```

- `default export`: Required by Remotion's bundler
- `named export`: Useful for testing/importing in other files

---

### Phase 3: Remotion Renderer Service

**Duration**: 4-5 hours  
**Complexity**: High  
**Risk**: Medium

#### Overview: What This Service Does

This service is the bridge between your Electron backend and Remotion. It:

1. Bundles the React composition (with caching)
2. Calculates composition parameters from Project data
3. Calls Remotion's rendering API
4. Tracks progress and emits events
5. Handles cancellation and cleanup

Think of it as a wrapper around `@remotion/renderer` that integrates with your architecture.

#### Step 3.1: Type Definitions

**File**: `src/electron/types/remotion.types.ts`

```typescript
/**
 * Progress event from Remotion during rendering.
 *
 * Remotion emits this for each rendered frame.
 */
export interface RemotionRenderProgress {
  /** Number of frames rendered so far */
  renderedFrames: number;

  /** Total frames to render */
  totalFrames: number;

  /** Progress percentage (0-100) */
  percent: number;

  /** Number of frames encoded (may lag behind rendered) */
  encodedFrames: number;

  /** Time when encoding finished (null if still encoding) */
  encodedDoneIn: number | null;
}

/**
 * Result of a Remotion render operation.
 */
export interface RemotionRenderResult {
  /** Whether rendering completed successfully */
  success: boolean;

  /** Path to output file (on success) */
  outputPath?: string;

  /** Error message (on failure) */
  error?: string;

  /** Video duration in seconds */
  duration?: number;
}
```

**Why These Types:**

**`RemotionRenderProgress`:**

- Mirrors Remotion's `onProgress` callback structure
- `renderedFrames` vs `encodedFrames`: Puppeteer renders frames first, FFmpeg encodes them after
- `percent`: Calculated for easy UI updates

**`RemotionRenderResult`:**

- Matches your existing `ExportResult` pattern
- `success` boolean makes error handling consistent
- `outputPath` points to temp file (for Stage 2)

#### Step 3.2: Renderer Service Implementation

**File**: `src/electron/services/remotion-renderer.service.ts`

This is the most complex file. Let's break it down section by section.

##### Part 1: Imports and State

```typescript
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition, getCompositions } from '@remotion/renderer';
import path from 'path';
import { randomUUID } from 'crypto';
import fs from 'fs';
import { app } from 'electron';
import type { Project } from '../types/project.types';
import type { ExportConfig } from '../types/exporter.types';
import type { RemotionRenderProgress, RemotionRenderResult } from '../types/remotion.types';
import * as compositorService from './compositor.service';
import * as ffmpegService from './ffmpeg.service';

/**
 * Cache for bundled composition.
 */
let bundleCache: string | null = null;
let isCancelled = false;

// Chrome resolution is handled by chrome-resolver.service.ts
import { ensureChromeBrowser } from './chrome-resolver.service';
```

**Why Cache the Bundle:**

Bundling process:

```
Source TypeScript → Webpack → Bundled JavaScript → Temp Folder
src/remotion/       (5-10s)    bundle/index.js      /tmp/remotion-bundle-xyz
```

First render: 10s bundle + 30s render = 40s total
Second render: 0s bundle + 30s render = 30s total (25% faster!)

**When to Clear Cache:**

- Development: After modifying composition code
- Production: Never (bundle is production-ready)
- Manual: Provide `clearCache()` function for testing

**Why Cancellation Flag:**

Remotion's API doesn't have:

```typescript
const handle = renderMedia(...);
handle.cancel(); // ❌ Doesn't exist
```

Instead, we throw an error in `onProgress`:

```typescript
onProgress: (...) => {
  if (isCancelled) {
    throw new Error('Cancelled');
  }
}
```

Remotion catches the error and stops rendering.

##### Part 2: Main Render Function

```typescript
export async function renderWithRemotion(
  project: Project,
  config: ExportConfig,
  onProgress: (progress: RemotionRenderProgress) => void,
): Promise<RemotionRenderResult> {
  isCancelled = false;
  const runId = randomUUID();
  const tempDir = path.join(process.cwd(), 'temp', runId);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // 1. Bundle the composition (or use cache)
    if (!bundleCache) {
      console.log('Bundling Remotion composition...');
      const bundled = await bundle({
        entryPoint: path.join(process.cwd(), 'src/remotion/index.ts'),
        // Webpack config adjustments if needed
      });
      bundleCache = bundled;
    }

    // 2. Resolve Composition
    const compositions = await getCompositions(bundleCache, {
      inputProps: { project, config, layout: {} as any }, // Partial props for discovery
    });
    const composition = compositions.find((c) => c.id === 'main');
    if (!composition) throw new Error('Composition not found');

    // 3. Prepare Layout & Props
    const durationInFrames = Math.ceil(project.duration * config.fps);
    const layout = compositorService.calculateLayout(project, config.width, config.height);

    const inputProps = {
      project,
      config,
      layout,
    };

    // 4. Render
    const tempOutputPath = path.join(tempDir, 'output.mp4');
    const browserExecutable = getBrowserExecutable();

    console.log(
      `[Remotion] Starting render with executable: ${browserExecutable || 'SYSTEM DEFAULT'}`,
    );

    await renderMedia({
      composition: {
        ...composition,
        durationInFrames,
        fps: config.fps,
        width: config.width,
        height: config.height,
      },
      serveUrl: bundleCache,
      codec: 'h264',
      outputLocation: tempOutputPath,
      inputProps,
      browserExecutable: browserExecutable || undefined, // undefined lets Remotion find it
      chromiumOptions: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
      onProgress: ({ renderedFrames, encodedFrames, encodedDoneIn }) => {
        if (isCancelled) throw new Error('Render cancelled');

        onProgress({
          renderedFrames,
          totalFrames: durationInFrames,
          percent: (renderedFrames / durationInFrames) * 100,
          encodedFrames,
          encodedDoneIn,
        });
      },
    });

    return {
      success: true,
      outputPath: tempOutputPath,
      duration: durationInSeconds,
    };
  } catch (error) {
    console.error('[RemotionRenderer] Render failed:', error);

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
```

**Step-by-Step Breakdown:**

**Step 1: Bundling**

- Checks cache first (skip if already bundled)
- `__dirname` points to `dist-electron/services/`
- `../remotion/index.js` is the transpiled entry point
- Bundling creates a self-contained folder with all dependencies

**Step 2: Probe Video**

- Reuses `ffmpegService.probeVideo()` to get duration
- Calculates total frames: `duration × fps`
- Example: 10s video at 30fps = 300 frames

**Step 3: Calculate Layout**

- Reuses `compositor.calculateLayout()` for consistency
- Same logic as editor preview
- Ensures WYSIWYG (what you see is what you get)

**Step 4: Input Props**

- Packages all data needed by composition
- Converts from internal types to Remotion-friendly structure
- Everything composition needs is explicitly passed

**Step 5: Select Composition**

- Loads bundled compositions
- Finds composition with `id="main"`
- Validates it exists before rendering

**Step 6: Output Path**

- Creates `.temp` folder in project directory
- Generates unique filename with UUID
- Example: `/path/to/project/.temp/remotion-abc123.mp4`

**Step 7: Render**
This is where the magic happens:

- `composition`: Metadata about what to render
- `serveUrl`: Path to bundle
- `codec: 'h264'`: Industry standard codec
- `crf: 15`: High quality (lower number = better quality, larger file)
- `chromiumOptions`: Configure Puppeteer
- `onProgress`: Called for each frame

**Step 8: Return Result**

- Returns temp file path for Stage 2 (FFmpeg)
- Includes duration for validation

**Error Handling:**
All errors caught and returned as `{ success: false, error: message }`
Consistent with existing `ExportResult` pattern

##### Part 3: Utility Functions

```typescript
/**
 * Cancel ongoing render.
 *
 * Sets cancellation flag, which causes onProgress callback
 * to throw an error, stopping the render.
 */
export function cancelRender(): void {
  console.log('[RemotionRenderer] Cancellation requested');
  isCancelled = true;
}

/**
 * Clear bundle cache.
 *
 * Forces rebundling on next render.
 * Useful for development when composition code changes.
 */
export function clearCache(): void {
  console.log('[RemotionRenderer] Clearing bundle cache');
  bundleCache = null;
}

/**
 * Get bundle status (for debugging).
 */
export function getBundleStatus(): { cached: boolean; path: string | null } {
  return {
    cached: bundleCache !== null,
    path: bundleCache,
  };
}
```

**Usage Examples:**

```typescript
// In exporter service
if (userClickedCancel) {
  remotionRenderer.cancelRender();
}

// In development tools
if (compositionCodeChanged) {
  remotionRenderer.clearCache();
}

// For debugging
console.log(remotionRenderer.getBundleStatus());
// → { cached: true, path: '/tmp/remotion-bundle-xyz' }
```

---

### Phase 4: Modify Exporter Service

**Duration**: 2-3 hours  
**Complexity**: Medium  
**Risk**: Medium

#### Overview: Two-Stage Pipeline

Currently, your exporter does everything in one FFmpeg call. We're splitting it into:

```
┌──────────────────────────────────────┐
│   Stage 1: Remotion (NEW)            │
│   • Background compositing            │
│   • Video positioning                 │
│   • Zoom animations                   │
│   • Cursor effects                    │
│   Output: temp-file.mp4              │
│   Progress: 0% → 60%                 │
└────────┬─────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────┐
│   Stage 2: FFmpeg (MODIFIED)         │
│   • Cut filter only                   │
│   • Scaling filter only               │
│   Input: temp-file.mp4               │
│   Output: final-file.mp4             │
│   Progress: 60% → 100%               │
└────────┬─────────────────────────────┘
         │
         ▼
    Final Output
```

**Why This Split:**

1. **Remotion's Strengths**: Visual effects, animations, layering
2. **FFmpeg's Strengths**: Cutting, upscaling, codec optimization
3. **Clean Separation**: Each tool does what it's best at
4. **Debuggable**: Can inspect temp file between stages

#### Step 4.1: Update Imports

At the top of `exporter.service.ts`, add:

```typescript
import * as remotionRenderer from '../remotion-renderer.service.js';
```

This gives you access to:

- `remotionRenderer.renderWithRemotion()`
- `remotionRenderer.cancelRender()`

#### Step 4.2: Replace Main Export Function

Currently, your `startExport` function calls `runFFmpegPipeline`. Replace that with:

```typescript
// In startExport(), around line 120:

try {
  // OLD: const result = await runFFmpegPipeline(project, config, outputPath);

  // NEW: Two-stage pipeline
  const result = await runTwoStagePipeline(project, config, outputPath);

  currentJob.state = 'completed';
  console.log('[ExporterService] Export completed successfully');
  return result;
} catch (error) {
  currentJob.state = 'error';
  currentJob.error = error instanceof Error ? error.message : 'Unknown error';
  console.error('[ExporterService] Export failed:', currentJob.error);
  return { success: false, error: currentJob.error };
}
```

**Why This Change:**

- Minimal change to existing flow
- Same error handling
- Same return type
- Just swaps the pipeline implementation

#### Step 4.3: Implement Two-Stage Pipeline

Add this new function (before `runFFmpegPipeline`):

```typescript
/**
 * Two-stage export pipeline.
 *
 * Stage 1: Remotion renders video with all effects (0-60% progress)
 * Stage 2: FFmpeg applies cuts and upscaling (60-100% progress)
 *
 * Why two stages?
 * - Remotion excels at visual effects and animations
 * - FFmpeg excels at cutting and upscaling
 * - Keeps each tool in its strength zone
 * - Easier to debug (can inspect intermediate file)
 *
 * @param project - Project to export
 * @param config - Export configuration
 * @param outputPath - Final output path
 * @returns Export result
 */
async function runTwoStagePipeline(
  project: Project,
  config: ExportConfig,
  outputPath: string,
): Promise<ExportResult> {
  console.log('[ExporterService] ====== Starting Two-Stage Pipeline ======');

  let remotionOutput: string | undefined;

  try {
    // ============================================================
    // STAGE 1: Remotion Rendering
    // ============================================================
    console.log('[ExporterService] STAGE 1: Remotion compositor');
    console.log('[ExporterService] Rendering background, video, and effects...');

    const remotionResult = await remotionRenderer.renderWithRemotion(
      project,
      config,
      (progress) => {
        if (!currentJob) return;

        // Map Remotion progress (0-100%) to total progress (0-60%)
        const stagePercent = progress.percent; // 0-100
        const totalPercent = Math.round(stagePercent * 0.6); // Maps to 0-60

        currentJob.progress = {
          percent: totalPercent,
          currentFrame: progress.renderedFrames,
          totalFrames: progress.totalFrames,
          fps: config.fps,
          eta: calculateETA(totalPercent, currentJob.startedAt),
        };

        // Emit to renderer process
        exporterEvents.emit('progress', currentJob.progress);
      },
    );

    // Check Remotion result
    if (!remotionResult.success || !remotionResult.outputPath) {
      throw new Error(remotionResult.error || 'Remotion render failed');
    }

    remotionOutput = remotionResult.outputPath;
    console.log('[ExporterService] STAGE 1 complete:', remotionOutput);
    console.log('[ExporterService] File size:', fs.statSync(remotionOutput).size, 'bytes');

    // ============================================================
    // STAGE 2: FFmpeg Post-Processing
    // ============================================================
    console.log('[ExporterService] STAGE 2: FFmpeg post-processing');
    console.log('[ExporterService] Applying cuts and upscaling...');

    const ffmpegResult = await runFFmpegPostProcessing(
      project,
      config,
      remotionOutput, // Input: Remotion's output
      outputPath, // Output: Final export path
      60, // Progress offset (start at 60%)
    );

    console.log('[ExporterService] STAGE 2 complete');
    console.log('[ExporterService] ====== Pipeline Complete ======');

    // ============================================================
    // Cleanup Temp Files
    // ============================================================
    if (fs.existsSync(remotionOutput)) {
      fs.unlinkSync(remotionOutput);
      console.log('[ExporterService] Cleaned up temp file');
    }

    return ffmpegResult;
  } catch (error) {
    console.error('[ExporterService] Pipeline failed:', error);

    // Clean up temp file on failure
    if (remotionOutput && fs.existsSync(remotionOutput)) {
      try {
        fs.unlinkSync(remotionOutput);
        console.log('[ExporterService] Cleaned up temp file after error');
      } catch (cleanupError) {
        console.warn('[ExporterService] Failed to cleanup temp file:', cleanupError);
      }
    }

    throw error;
  }
}
```

**Detailed Explanation:**

**Progress Mapping:**

```
Remotion outputs:  0%  25%  50%  75% 100%
                   ↓    ↓    ↓    ↓    ↓
Total progress:    0%  15%  30%  45%  60%

FFmpeg outputs:    0%  25%  50%  75% 100%
                   ↓    ↓    ↓    ↓    ↓
Total progress:   60%  70%  80%  90% 100%
```

Formula:

```typescript
// Stage 1:
totalPercent = stagePercent * 0.6;

// Stage 2:
totalPercent = 60 + stagePercent * 0.4;
```

**Why 60/40 Split:**

- Remotion typically takes 60% of time (rendering is intensive)
- FFmpeg cuts/upscaling takes 40% (simpler operations)
- Adjust if you find different ratios in practice

**Error Handling:**

- If Stage 1 fails → clean up (nothing to clean yet)
- If Stage 2 fails → clean up temp file from Stage 1
- Always clean up on success

**Temp File Cleanup:**

```typescript
if (fs.existsSync(remotionOutput)) {
  fs.unlinkSync(remotionOutput);
}
```

Why wait until now?

- If Stage 2 fails, you can debug the temp file
- Only delete after confirmed success
- Prevents orphaned files from accumulating

#### Step 4.4: Implement FFmpeg Post-Processor

Add this function after `runTwoStagePipeline`:

```typescript
/**
 * FFmpeg post-processing stage.
 *
 * Takes Remotion's output and applies:
 * - Cut filter (remove unwanted segments)
 * - Scaling filter (upscale to target resolution)
 *
 * Why these filters only?
 * - Background/zoom already applied by Remotion
 * - Cuts must happen after effects (otherwise duration changes)
 * - Upscaling is FFmpeg's specialty (Lanczos algorithm)
 *
 * @param project - Project data (for cut regions)
 * @param config - Export config (for resolution)
 * @param inputPath - Remotion's output file
 * @param outputPath - Final output path
 * @param progressOffset - Starting progress percentage (typically 60)
 */
async function runFFmpegPostProcessing(
  project: Project,
  config: ExportConfig,
  inputPath: string,
  outputPath: string,
  progressOffset: number,
): Promise<ExportResult> {
  const ffmpegPath = ffmpegService.getFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('FFmpeg not initialized');
  }

  // Probe the temp file (from Remotion)
  const metadata = await ffmpegService.probeVideo(inputPath);
  const videoDuration = metadata.duration;
  const totalFrames = Math.ceil(videoDuration * config.fps);

  console.log('[ExporterService] Post-processing:', totalFrames, 'frames');

  return new Promise((resolve, reject) => {
    // Create filter context
    const context = createFilterContext(project, config, videoDuration);

    // IMPORTANT: Only use cut and scaling filters
    // Background and zoom were already applied by Remotion
    const postProcessFilters = [cutFilter, scalingFilter];

    const enabledFilters = postProcessFilters
      .filter((f) => f.isEnabled(context))
      .sort((a, b) => a.priority - b.priority);

    console.log(
      '[ExporterService] Enabled post-process filters:',
      enabledFilters.map((f) => f.name),
    );

    // Build video filter chain
    const videoFilters: string[] = [];
    for (const filter of enabledFilters) {
      const filters = filter.getVideoFilters(context);
      if (filters) {
        videoFilters.push(...filters);
      }
    }

    // Build FFmpeg arguments
    const args = [
      '-y', // Overwrite output
      '-i',
      inputPath,
    ];

    // Apply filters if any
    if (videoFilters.length > 0) {
      args.push('-vf', videoFilters.join(','));
    }

    // Output settings (codec, quality, etc.)
    const outputArgs = getOutputSettingsArgs(config);
    args.push(...outputArgs);

    // Output path
    args.push(outputPath);

    console.log('[ExporterService] FFmpeg command:', ffmpegPath, args.join(' '));

    // Spawn FFmpeg
    const child = spawn(ffmpegPath, args);
    ffmpegProcess = child;

    let lastEmitTime = 0;
    const THROTTLE_MS = 200; // Emit progress max once per 200ms

    // Parse progress from stderr
    child.stderr.on('data', (data) => {
      const output = data.toString();

      const frameMatch = output.match(/frame=\s*(\d+)/);
      const fpsMatch = output.match(/fps=\s*(\d+(?:\.\d+)?)/);

      if (frameMatch && currentJob) {
        const currentFrame = parseInt(frameMatch[1], 10);
        const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 0;

        // Calculate progress within this stage (0-100%)
        const stagePercent = Math.min(100, (currentFrame / totalFrames) * 100);

        // Map to total progress (60-100%)
        const totalPercent = Math.round(progressOffset + stagePercent * 0.4);

        currentJob.progress = {
          percent: totalPercent,
          currentFrame,
          totalFrames,
          fps,
          eta: calculateETA(totalPercent, currentJob.startedAt),
        };

        // Throttle updates to avoid overwhelming UI
        const now = Date.now();
        if (now - lastEmitTime >= THROTTLE_MS || totalPercent === 100) {
          exporterEvents.emit('progress', currentJob.progress);
          lastEmitTime = now;
        }
      }
    });

    // Handle completion
    child.on('close', (code) => {
      ffmpegProcess = null;

      if (code === 0) {
        // Success!
        try {
          const stats = fs.statSync(outputPath);
          resolve({
            success: true,
            outputPath,
            duration: videoDuration,
            fileSize: stats.size,
          });
        } catch {
          resolve({
            success: true,
            outputPath,
            duration: videoDuration,
          });
        }
      } else {
        // Failure
        if (currentJob?.state === 'cancelled') {
          reject(new Error('Export cancelled'));
        } else {
          reject(new Error(`FFmpeg exited with error code ${code}`));
        }
      }
    });

    // Handle spawn errors
    child.on('error', (err) => {
      ffmpegProcess = null;
      reject(err);
    });
  });
}
```

**Key Points:**

**Filter Selection:**

```typescript
const postProcessFilters = [cutFilter, scalingFilter];
```

NOT:

```typescript
const allFilters = [backgroundFilter, zoomFilter, cutFilter, scalingFilter];
```

Why? Background and zoom were already applied by Remotion. Applying them again would:

- Double-apply effects (wrong output)
- Waste time re-processing
- Potentially break the video

**Progress Calculation:**

```typescript
const stagePercent = (currentFrame / totalFrames) * 100; // 0-100
const totalPercent = progressOffset + stagePercent * 0.4; // 60-100
```

Example:

- FFmpeg is 50% done with its work → stagePercent = 50
- Total progress = 60 + (50 \* 0.4) = 60 + 20 = 80%

**Throttling:**

```typescript
const THROTTLE_MS = 200;
if (now - lastEmitTime >= THROTTLE_MS) {
  exporterEvents.emit('progress', ...);
}
```

Why? FFmpeg updates very frequently (multiple times per second). Emitting every update:

- Lags the UI
- Wastes IPC bandwidth
- Doesn't improve UX (users can't perceive <200ms updates)

#### Step 4.5: Update cancelExport

Modify the existing `cancelExport` function to cancel both stages:

```typescript
/**
 * Cancel the current export.
 *
 * Now handles cancellation of both stages:
 * - Remotion rendering
 * - FFmpeg post-processing
 */
export function cancelExport(): boolean {
  if (!currentJob || currentJob.state !== 'exporting') {
    return false;
  }

  console.log('[ExporterService] Cancelling export:', currentJob.id);

  // Cancel Remotion (if Stage 1 is running)
  remotionRenderer.cancelRender();

  // Cancel FFmpeg (if Stage 2 is running)
  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGKILL');
    ffmpegProcess = null;
  }

  currentJob.state = 'cancelled';

  // Clean up partial output file
  if (currentJob.outputPath && fs.existsSync(currentJob.outputPath)) {
    try {
      fs.unlinkSync(currentJob.outputPath);
      console.log('[ExporterService] Cleaned up partial output file');
    } catch (err) {
      console.warn('[ExporterService] Failed to clean up partial file:', err);
    }
  }

  // Clean up temp directory
  const project = editorService.getActiveProject();
  if (project) {
    const tempDir = path.join(project.projectFolderPath, '.temp');
    if (fs.existsSync(tempDir)) {
      try {
        const files = fs.readdirSync(tempDir);
        for (const file of files) {
          const filePath = path.join(tempDir, file);
          fs.unlinkSync(filePath);
          console.log('[ExporterService] Cleaned up temp file:', file);
        }
      } catch (err) {
        console.warn('[ExporterService] Failed to cleanup temp dir:', err);
      }
    }
  }

  return true;
}
```

**What Changed:**

1. Added `remotionRenderer.cancelRender()` call
2. Added temp directory cleanup
3. More detailed logging

**Why Clean Temp Directory:**
If user cancels during Stage 1, there might be:

- `remotion-abc123.mp4` (partial render)
- Other orphaned temp files from previous cancelled exports

Cleaning ensures no disk space waste.

---

### Phase 5: Testing & Validation

**Duration**: 2-3 hours  
**Complexity**: Low-Medium  
**Risk**: Low

#### Why Testing Matters

This is a major architectural change. Thorough testing ensures:

1. **Correctness**: Output matches expected behavior
2. **Quality**: No visual regressions
3. **Performance**: Acceptable rendering times
4. **Robustness**: Handles edge cases and errors gracefully

#### Test 5.1: Basic Export

**Objective**: Verify the pipeline works end-to-end.

**Steps:**

1. Open your app
2. Load a simple project (no cuts, no zoom)
3. Click Export
4. Wait for completion

**Expected Results:**

- Progress bar moves smoothly from 0% → 60% (Remotion) → 100% (FFmpeg)
- Final video plays correctly
- Background color/image renders correctly
- Video is centered/scaled properly

**What to Check:**

```
Console logs should show:
[RemotionRenderer] Bundling composition...
[RemotionRenderer] Bundle cached at: /tmp/...
[RemotionRenderer] Video duration: 10.5 s
[RemotionRenderer] Frames to render: 315
[RemotionRenderer] Progress: 0/315 (0%)
...
[RemotionRenderer] Progress: 315/315 (100%)
[RemotionRenderer] Render complete!
[ExporterService] STAGE 1 complete: .../remotion-abc123.mp4
[ExporterService] STAGE 2: FFmpeg post-processing
[ExporterService] Progress: ...
[ExporterService] STAGE 2 complete
[ExporterService] Cleaned up temp file
```

**Pass Criteria:**

- ✅ No errors in console
- ✅ Final video file exists
- ✅ Video plays without issues
- ✅ Temp file deleted automatically

#### Test 5.2: Export with Zoom

**Objective**: Verify zoom animations work correctly.

**Setup:**

1. Create a project
2. Add a zoom region (e.g., 2s to 5s, zoom level 2.0, focal point center)
3. Export

**Expected Results:**

- Video smoothly zooms in from 2s to ~2.5s (ease in)
- Holds zoom from 2.5s to 4.5s
- Smoothly zooms out from 4.5s to 5s (ease out)
- Zoom focuses on correct focal point

**How to Verify:**

1. Play exported video
2. Scrub to zoom region
3. Check animation smoothness (no jerky motion)
4. Verify focal point is correct (video zooms "into" the right spot)

**Pass Criteria:**

- ✅ Zoom animation is smooth (no stuttering)
- ✅ Easing curves work (not linear)
- ✅ Focal point is correct
- ✅ Better quality than old FFmpeg zoom filter

#### Test 5.3: Export with Cuts

**Objective**: Verify cuts are applied correctly.

**Setup:**

1. Create a 10s video project
2. Add cut regions: 2s-4s, 7s-8s
3. Export

**Expected Results:**

- Final video duration: 10 - 2 - 1 = 7 seconds
- Playback goes: 0-2s → jumps to 4-7s → jumps to 8-10s
- No visible artifacts at cut points
- Audio stays in sync (if present)

**How to Verify:**

1. Check final video duration (should be 7s)
2. Watch for smooth transitions at cut points
3. Listen for audio sync issues

**Pass Criteria:**

- ✅ Correct duration
- ✅ Smooth playback
- ✅ No visual glitches at cuts

#### Test 5.4: Export with All Features

**Objective**: Stress test with everything enabled.

**Setup:**

1. Create a project with:
   - Background image
   - Multiple zoom regions
   - Multiple cut regions
   - Various resolution (1080p)

**Expected Results:**

- All features work together
- No conflicts or interference between effects
- Final video is correct

**Pass Criteria:**

- ✅ Background renders correctly
- ✅ Zooms work during zoomed sections
- ✅ Cuts remove correct segments
- ✅ Final video quality is high

#### Test 5.5: Cancellation Test

**Objective**: Verify cancellation works at both stages.

**Test A: Cancel during Stage 1 (Remotion)**

1. Start export
2. Wait until progress is ~30% (Stage 1)
3. Click Cancel

**Expected:**

- Remotion stops rendering
- Temp file is deleted
- UI shows "Cancelled" state
- No orphaned processes

**Test B: Cancel during Stage 2 (FFmpeg)**

1. Start export
2. Wait until progress is ~80% (Stage 2)
3. Click Cancel

**Expected:**

- FFmpeg process killed
- Partial output file deleted
- Temp file deleted
- UI shows "Cancelled" state

**Pass Criteria:**

- ✅ Cancellation is immediate (<1 second)
- ✅ All temp files cleaned up
- ✅ No zombie processes remaining
- ✅ Can start new export immediately after

#### Test 5.6: Resolution Scaling

**Objective**: Verify FFmpeg upscaling works correctly.

**Test Cases:**

1. Export at 720p (original: 1080p) → downscale
2. Export at 1080p (original: 1080p) → no scale
3. Export at 4K (original: 1080p) → upscale

**Expected:**

- 720p: Video scales down, maintains quality
- 1080p: No scaling, fast export
- 4K: Video upscales with good quality

**How to Verify:**

1. Check file size (720p < 1080p < 4K)
2. Inspect video properties (right-click → Properties)
3. Compare visual quality

**Pass Criteria:**

- ✅ Correct output resolution
- ✅ Aspect ratio maintained
- ✅ Upscaling looks good (no pixelation)

#### Test 5.7: Error Handling

**Objective**: Verify graceful error handling.

**Test Scenarios:**

**A. Missing Source Video**

1. Delete project's raw video file
2. Try to export

**Expected:**

- Clear error message: "Source video not found"
- No crash
- Can still use other parts of app

**B. Disk Space Full**

1. Fill disk until <100MB free
2. Try to export large project

**Expected:**

- Error message about disk space
- Partial files cleaned up
- App remains stable

**C. Corrupted Video File**

1. Create a project with corrupted video
2. Try to export

**Expected:**

- Error message from FFprobe or Remotion
- Doesn't hang or crash
- Can try again with different project

**Pass Criteria:**

- ✅ All errors have clear messages
- ✅ No silent failures
- ✅ App remains stable after errors
- ✅ Temp files cleaned up even on error

---

### Phase 6: Error Handling & Polish

**Duration**: 1-2 hours  
**Complexity**: Low  
**Risk**: Low

#### Why Polish Matters

Users don't see the code - they see:

- Progress updates
- Error messages
- Responsiveness

Good polish makes the difference between "it works" and "it works well."

#### Step 6.1: Validation Before Rendering

Add validation at the start of `renderWithRemotion`:

```typescript
export async function renderWithRemotion(
  project: Project,
  config: ExportConfig,
  onProgress?: (progress: RemotionRenderProgress) => void,
): Promise<RemotionRenderResult> {
  isCancelled = false;

  // ============================================================
  // Pre-Render Validation
  // ============================================================

  // Validate source video exists
  if (!fs.existsSync(project.rawVideoPath)) {
    console.error('[RemotionRenderer] Source video not found:', project.rawVideoPath);
    return {
      success: false,
      error: `Source video not found: ${path.basename(project.rawVideoPath)}`,
    };
  }

  // Validate video file is not empty
  const stats = fs.statSync(project.rawVideoPath);
  if (stats.size === 0) {
    console.error('[RemotionRenderer] Source video is empty (0 bytes)');
    return {
      success: false,
      error: 'Source video file is empty',
    };
  }

  // Validate video dimensions
  if (!project.videoDimensions.width || !project.videoDimensions.height) {
    console.error('[RemotionRenderer] Invalid video dimensions:', project.videoDimensions);
    return {
      success: false,
      error: 'Video dimensions are invalid',
    };
  }

  // Validate canvas size
  const canvasSize = compositorService.getCanvasSize();
  if (canvasSize.width <= 0 || canvasSize.height <= 0) {
    console.error('[RemotionRenderer] Invalid canvas size:', canvasSize);
    return {
      success: false,
      error: 'Canvas size is invalid',
    };
  }

  // If background image specified, check it exists
  if (project.backgroundPath && !fs.existsSync(project.backgroundPath)) {
    console.warn('[RemotionRenderer] Background image not found:', project.backgroundPath);
    // Don't fail - just fall back to solid color
    project.backgroundPath = undefined;
  }

  console.log('[RemotionRenderer] Validation passed');

  // ... rest of function
}
```

**Why Validate:**

- Fail fast with clear messages
- Prevent cryptic errors later in pipeline
- Better user experience (immediate feedback)

#### Step 6.2: Enhanced Progress Messages

Update progress events to include stage information.

In `runTwoStagePipeline`, modify progress emission:

```typescript
// Stage 1 progress
const remotionResult = await remotionRenderer.renderWithRemotion(
  project,
  config,
  (progress) => {
    if (!currentJob) return;

    currentJob.progress = {
      percent: Math.round(progress.percent * 0.6),
      currentFrame: progress.renderedFrames,
      totalFrames: progress.totalFrames,
      fps: config.fps,
      eta: calculateETA(...),

      // NEW: Stage information
      stage: 'remotion',
      stageLabel: 'Rendering effects and animations...',
      stagePercent: progress.percent,
    };

    exporterEvents.emit('progress', currentJob.progress);
  }
);

// Stage 2 progress
const ffmpegResult = await runFFmpegPostProcessing(
  // ... in the progress callback:
  currentJob.progress = {
    // ...
    stage: 'ffmpeg',
    stageLabel: 'Applying cuts and upscaling...',
    stagePercent: stagePercent,
  };
);
```

**Update Type:**

In `src/electron/types/exporter.types.ts`:

```typescript
export interface ExportProgress {
  percent: number;
  currentFrame: number;
  totalFrames: number;
  fps: number;
  eta: number;

  // New fields
  stage?: 'remotion' | 'ffmpeg';
  stageLabel?: string;
  stagePercent?: number;
}
```

**UI Benefits:**

```
Before:
[████████░░░░░░] 45%

After:
[████████░░░░░░] 45%
Rendering effects and animations... (75% of stage 1)
```

Users can see:

1. Overall progress
2. Current stage
3. Progress within stage

#### Step 6.3: Better Error Messages

Replace generic errors with specific, actionable messages.

**Example: Remotion Bundling Error**

```typescript
try {
  bundleCache = await bundle({ entryPoint });
} catch (error) {
  console.error('[RemotionRenderer] Bundling failed:', error);

  // Check for common issues
  if (error.message.includes('ENOENT')) {
    return {
      success: false,
      error: 'Remotion composition files not found. Try restarting the app.',
    };
  }

  if (error.message.includes('webpack')) {
    return {
      success: false,
      error: 'Failed to bundle composition. This might be a dependency issue.',
    };
  }

  // Generic fallback
  return {
    success: false,
    error: `Bundling error: ${error.message}`,
  };
}
```

**Example: Puppeteer Launch Error**

```typescript
try {
  await renderMedia({ chromiumOptions: { headless: true } });
} catch (error) {
  if (error.message.includes('Chromium') || error.message.includes('puppeteer')) {
    return {
      success: false,
      error: 'Failed to launch browser for rendering. Chrome installation may be corrupted.',
    };
  }

  throw error;
}
```

#### Step 6.4: Cleanup on App Start

Add cleanup for orphaned temp files when app starts.

**File:** `src/electron/main.ts` (or wherever app initialization happens)

```typescript
import { app } from 'electron';
import * as projectStorage from './services/project-storage.service';
import path from 'path';
import fs from 'fs';

app.on('ready', async () => {
  // ... existing initialization

  // Clean up orphaned temp files
  await cleanupOrphanedTempFiles();
});

/**
 * Clean up .temp folders in all project directories.
 *
 * Orphaned files can accumulate from:
 * - App crashes during export
 * - Force quit during rendering
 * - Failed exports
 *
 * This cleanup runs once on app start.
 */
async function cleanupOrphanedTempFiles(): Promise<void> {
  try {
    console.log('[Main] Cleaning up orphaned temp files...');

    // Get all projects
    const projects = await projectStorage.getAllProjects();
    let cleanedCount = 0;

    for (const project of projects) {
      const tempDir = path.join(project.projectFolderPath, '.temp');

      if (fs.existsSync(tempDir)) {
        try {
          const files = fs.readdirSync(tempDir);

          for (const file of files) {
            const filePath = path.join(tempDir, file);
            fs.unlinkSync(filePath);
            cleanedCount++;
          }

          // Remove empty .temp directory
          fs.rmdirSync(tempDir);
        } catch (err) {
          console.warn('[Main] Failed to cleanup temp dir:', tempDir, err);
        }
      }
    }

    if (cleanedCount > 0) {
      console.log(`[Main] Cleaned up ${cleanedCount} orphaned temp files`);
    } else {
      console.log('[Main] No orphaned temp files found');
    }
  } catch (error) {
    console.error('[Main] Temp file cleanup failed:', error);
    // Don't throw - app should still start
  }
}
```

**Why This Helps:**

- Prevents disk space waste
- Cleans up after crashes
- Improves app perception (users notice if temp files pile up)

#### Step 6.5: Add Development Tools

**For Development Only:**

Add IPC endpoints for debugging:

```typescript
// In ipc/exporter.ipc.ts

ipcMain.handle('exporter:clear-remotion-cache', async () => {
  remotionRenderer.clearCache();
  return { success: true };
});

ipcMain.handle('exporter:get-bundle-status', async () => {
  return remotionRenderer.getBundleStatus();
});

ipcMain.handle('exporter:cleanup-temp-files', async () => {
  // Manual cleanup trigger
  const project = editorService.getActiveProject();
  if (!project) return { success: false };

  const tempDir = path.join(project.projectFolderPath, '.temp');
  // ... cleanup logic

  return { success: true, cleaned: count };
});
```

**Usage in Dev Tools:**

```typescript
// In a dev menu or debug panel
<button onClick={() => window.electron.clearRemotionCache()}>
  Clear Remotion Cache
</button>

<button onClick={() => window.electron.cleanupTempFiles()}>
  Clean Temp Files
</button>
```

---

## Timeline Summary

### Critical Path (Must Complete)

| Phase                   | Duration  | Cumulative  |
| ----------------------- | --------- | ----------- |
| 1. Dependencies         | 30 min    | 30 min      |
| 2. Compositions         | 3-4 hours | 4-5 hours   |
| 3. Renderer Service     | 4-5 hours | 9-10 hours  |
| 4. Exporter Integration | 2-3 hours | 12-13 hours |
| 5. Testing              | 2-3 hours | 15-16 hours |
| 6. Polish               | 1-2 hours | 17-18 hours |

### **Total Estimated Time: 17-18 hours (2-3 days)**

### Breakdown by Day

**Day 1 (6-7 hours):**

- ✅ Install dependencies
- ✅ Create all Remotion components
- ✅ Basic composition works in isolation
- 🎯 Milestone: Can bundle and preview composition

**Day 2 (6-7 hours):**

- ✅ Complete renderer service
- ✅ Integrate into exporter
- ✅ First successful end-to-end export
- 🎯 Milestone: Pipeline works for simple project

**Day 3 (5-6 hours):**

- ✅ Comprehensive testing
- ✅ Error handling
- ✅ Polish and optimization
- 🎯 Milestone: Production-ready

---

## Technical Deep Dives

### Deep Dive 1: How Remotion Rendering Works

**High-Level Process:**

```
1. Bundle Phase
   ├─ Webpack bundles React composition
   ├─ Output: Self-contained JS bundle
   └─ Cached for future renders

2. Initialization Phase
   ├─ Launch Puppeteer (headless Chrome)
   ├─ Navigate to bundle
   └─ Inject inputProps

3. Rendering Phase (for each frame)
   ├─ Set frame number (window.remotionCurrentFrame = N)
   ├─ Let React render
   ├─ Wait for all resources (images, videos)
   ├─ Take screenshot
   └─ Save as PNG

4. Encoding Phase
   ├─ Pass all PNGs to FFmpeg
   ├─ Encode to video (H.264)
   └─ Output final MP4
```

**Why This Works:**

**Frame-Perfect Rendering:**

```typescript
// In your React component:
const frame = useCurrentFrame(); // Remotion provides this

// Remotion does this for each frame:
for (let i = 0; i < durationInFrames; i++) {
  window.remotionCurrentFrame = i;
  // React re-renders
  // Screenshot taken
}
```

Every frame is rendered independently - no timing issues!

**Video Synchronization:**

```typescript
<Video src="video.mp4" />

// Remotion converts to:
<video currentTime={frame / fps} />
```

The `<Video>` component seeks to the exact timestamp for that frame.

**Why Headless Chrome:**

- Same rendering engine as preview
- Full web platform support (Canvas, WebGL, CSS)
- Reliable and consistent
- Cross-platform

### Deep Dive 2: Bundle Caching Strategy

**The Problem:**

Bundling is expensive:

```
Webpack needs to:
1. Resolve imports (~1s)
2. Transpile TypeScript (~2s)
3. Bundle React (~3s)
4. Optimize output (~2s)
Total: ~8s
```

If you bundle on every export:

```
User workflow:
Export → wait 8s → render 30s → done
Export again → wait 8s → render 30s → done
                 ^^^^^^^^ Wasteful!
```

**The Solution: Cache**

```typescript
let bundleCache: string | null = null;

if (!bundleCache) {
  bundleCache = await bundle(...); // 8s
} else {
  // Reuse cached bundle (0s)
}
```

First export: 8s + 30s = 38s
Second export: 0s + 30s = 30s (21% faster!)

**When to Clear Cache:**

**Development:**

- After modifying composition code
- After changing Remotion components
- After updating dependencies

**Production:**

- Never (bundle is immutable once built)

**How to Force Clear:**

```typescript
// Expose in dev tools
remotionRenderer.clearCache();
```

**Trade-offs:**

**Pros:**

- Much faster subsequent exports
- No repeated work
- Better UX for users who export multiple times

**Cons:**

- First export is slower (one-time cost)
- Cache uses disk space (~10-50MB)
- Must manually clear if composition changes in dev

**Best Practice:**
Keep caching in production, provide manual clear button in dev mode.

### Deep Dive 3: Progress Mapping Mathematics

**The Challenge:**

You have two sequential processes with different durations:

```
Stage 1 (Remotion): 60 seconds (0-100% internal progress)
Stage 2 (FFmpeg):   40 seconds (0-100% internal progress)
Total:              100 seconds
```

How do you map internal progress to total progress?

**The Math:**

**Stage 1 Mapping:**

```
Internal:      0%    25%    50%    75%   100%
               ↓      ↓      ↓      ↓      ↓
Total:         0%    15%    30%    45%    60%

Formula: totalPercent = internalPercent × 0.6
```

Why 0.6? Because Stage 1 is 60% of total time (60/100 = 0.6)

**Stage 2 Mapping:**

```
Internal:      0%    25%    50%    75%   100%
               ↓      ↓      ↓      ↓      ↓
Total:        60%    70%    80%    90%   100%

Formula: totalPercent = 60 + (internalPercent × 0.4)
```

Why 60 + (x × 0.4)?

- Start at 60% (where Stage 1 ended)
- Add 0-40% based on Stage 2 progress (40/100 = 0.4)

**General Formula:**

For N stages with duration weights w1, w2, ..., wN:

```
Stage i progress:
offseti = Σ(w1 to wi-1)  // Sum of previous stage weights
totalPercent = offseti + (internalPercent × wi)
```

**Example with 3 Stages:**

```
Stage 1: 50% of time (w1 = 0.5)
Stage 2: 30% of time (w2 = 0.3)
Stage 3: 20% of time (w3 = 0.2)

Stage 1: total = 0 + (internal × 0.5)      → 0-50%
Stage 2: total = 50 + (internal × 0.3)     → 50-80%
Stage 3: total = 80 + (internal × 0.2)     → 80-100%
```

**Code Implementation:**

```typescript
// Stage 1
const stage1Weight = 0.6;
const stage1Offset = 0;
const totalPercent = stage1Offset + stagePercent * stage1Weight;

// Stage 2
const stage2Weight = 0.4;
const stage2Offset = 60; // or stage1Weight * 100
const totalPercent = stage2Offset + stagePercent * stage2Weight;
```

### Deep Dive 4: Why These Specific Technologies?

**Question: Why Remotion specifically?**

**Alternatives Considered:**

| Tool                        | Pros                 | Cons                                    | Decision            |
| --------------------------- | -------------------- | --------------------------------------- | ------------------- |
| **After Effects Scripting** | Professional tools   | Requires AE license, not cross-platform | ❌                  |
| **FFmpeg Only**             | Fast, reliable       | Limited animations, hard to maintain    | Current (replacing) |
| **Canvas + FFmpeg**         | Full control         | Complex to implement, no React          | ❌                  |
| **Remotion**                | React-based, good DX | Slower than native                      | ✅ **Winner**       |
| **Lottie + Bodymovin**      | Great animations     | Animation-focused, not video            | ❌                  |

**Why Remotion Won:**

1. **React Ecosystem**: You already use React for UI
2. **TypeScript Support**: Type-safe compositions
3. **Live Preview**: `remotion preview` for development
4. **Community**: Active community, good documentation
5. **Maintenance**: Easy to maintain React components vs FFmpeg filters
6. **Extensibility**: Can add any React library (Three.js, D3, etc.)

**Question: Why Not Server-Side Rendering (SSR)?**

**SSR Approach:**

```
Node.js → ReactDOMServer → HTML → Puppeteer → Screenshots
```

**Remotion Approach:**

```
Node.js → Bundle → Puppeteer → React renders → Screenshots
```

**Why Remotion is Better:**

- Remotion's renderer is optimized for video
- Handles timing and playback automatically
- Built-in progress tracking
- Better performance (parallel rendering)

**Question: Why Keep FFmpeg?**

**Could we do everything in Remotion?**

Technically yes:

```typescript
// In Remotion composition
if (currentTimeMs in cutRegions) {
  return null; // Don't render this frame
}
```

**Why we don't:**

1. **Cuts Change Duration**: Remotion expects fixed frame count
2. **Upscaling**: FFmpeg's Lanczos algorithm is excellent
3. **Performance**: FFmpeg is faster for simple operations
4. **Separation**: Each tool does what it's best at

**The Hybrid Approach is Optimal:**

- Remotion: Complex visual effects
- FFmpeg: Simple post-processing

---

## Troubleshooting Guide

### Issue 1: "Bundling Failed" Error

**Symptoms:**

```
[RemotionRenderer] Bundling composition...
Error: ENOENT: no such file or directory, open '.../remotion/index.js'
```

**Cause:** TypeScript files not transpiled to JavaScript.

**Solution:**

```powershell
# Transpile Electron TypeScript
pnpm transpile:electron

# Check output
ls dist-electron/remotion/
# Should see: index.js, Composition.js, etc.
```

**Why This Happens:**

- `bundle()` expects JavaScript, not TypeScript
- Your build process must transpile first
- In development, run `pnpm dev:electron` which does this automatically

### Issue 2: "Chromium Not Found" Error

**Symptoms:**

```
Error: Could not find Chromium (rev 123456).
```

**Cause:** Puppeteer's Chromium not downloaded.

**Solution:**

```powershell
# Reinstall Puppeteer
pnpm remove puppeteer
pnpm add puppeteer

# Or manually download
npx puppeteer browsers install chrome
```

**Prevention:**
Add to `.npmrc`:

```
puppeteer_skip_download=false
```

### Issue 3: Slow Rendering Performance

**Symptoms:**

- Stage 1 takes 5+ minutes for 30s video
- High CPU usage
- Browser becomes unresponsive

**Possible Causes & Solutions:**

**A. Too Many Concurrent Renders**

```typescript
await renderMedia({
  concurrency: 4, // Default is 1
  // Lower if system struggles
});
```

**B. Large Background Images**

```typescript
// Optimize images before using
// Max 4K for backgrounds
if (imageWidth > 3840) {
  // Resize or show warning
}
```

**C. Complex Effects**

```typescript
// Profile your composition
// Check for expensive operations in render
console.time('frame-render');
// Your render code
console.timeEnd('frame-render');
// Should be <100ms per frame
```

**D. No GPU Acceleration**

```typescript
await renderMedia({
  chromiumOptions: {
    args: ['--enable-gpu-rasterization', '--enable-zero-copy'],
  },
});
```

### Issue 4: Temp Files Not Cleaning Up

**Symptoms:**

- `.temp` folder grows over time
- Disk space fills up
- Manual cleanup needed

**Debug:**

```typescript
// Check what's in temp folder
const tempDir = path.join(project.projectFolderPath, '.temp');
const files = fs.readdirSync(tempDir);
console.log('Temp files:', files);
```

**Common Causes:**

**A. Exception Before Cleanup**

```typescript
// Solution: Use try/finally
try {
  await renderWithRemotion(...);
} finally {
  // Always clean up, even on error
  if (fs.existsSync(tempFile)) {
    fs.unlinkSync(tempFile);
  }
}
```

**B. App Crashed**

- Use app startup cleanup (Phase 6.4)
- Runs every time app starts

**C. Process Killed Externally**

- Can't prevent this
- Startup cleanup will handle it

### Issue 5: Video Out of Sync

**Symptoms:**

- Audio doesn't match video
- Frames are skipped or repeated
- Video looks stuttery

**Debug:**

```typescript
// Check video probe
const meta = await ffprobe(videoPath);
console.log('FPS:', meta.fps);
console.log('Duration:', meta.duration);

// Ensure composition matches
console.log('Composition FPS:', config.fps);
console.log('Composition frames:', durationInFrames);
```

**Solutions:**

**A. FPS Mismatch**

```typescript
// Use source video's FPS
const metadata = await ffmpegService.probeVideo(project.rawVideoPath);
const sourceFps = metadata.fps || 30;

// Use this for Remotion
config.fps = sourceFps;
```

**B. Frame Rounding**

```typescript
// Use ceiling to avoid cutting last frame
const durationInFrames = Math.ceil(duration * fps);
// Not floor or round
```

**C. Remotion <Video> Issues**

```typescript
// Ensure one video per composition
// Multiple videos can cause sync issues
<Video src={singleSource} />
// Not: <Video src={source1} /> + <Video src={source2} />
```

### Issue 6: "Composition Not Found" Error

**Symptoms:**

```
Error: Composition "main" not found in bundle
```

**Debug:**

```typescript
const compositions = await getCompositions(bundleCache);
console.log(
  'Available compositions:',
  compositions.map((c) => c.id),
);
```

**Solutions:**

**A. ID Mismatch**

```typescript
// In remotion/index.ts:
<Composition id="main" ... />
//               ^^^^ Must match

// In renderer:
const comp = compositions.find(c => c.id === 'main');
//                                          ^^^^ Must match
```

**B. Export Issue**

```typescript
// In remotion/index.ts, must have:
export default function RemotionRoot() {
  return <><Composition ... /></>;
}
// Don't forget the default export!
```

**C. Bundle Cache Stale**

```typescript
// Clear cache and try again
remotionRenderer.clearCache();
```

### Issue 7: Quality Issues

**Symptoms:**

- Blurry output
- Compression artifacts
- Colors look washed out

**Solutions:**

**A. Increase CRF Quality**

```typescript
await renderMedia({
  crf: 15, // Lower = better (try 12 for higher quality)
  // 0 = lossless (huge files)
  // 15-18 = high quality (recommended)
  // 23 = medium
  // 28+ = low quality
});
```

**B. Use Better Pixel Format**

```typescript
await renderMedia({
  pixelFormat: 'yuv420p', // Standard
  // Or yuv444p for better color
});
```

**C. Check Source Quality**

```typescript
// Remotion output should be high quality
// Then FFmpeg should preserve it
const outputArgs = getOutputSettingsArgs(config);
// Should use crf: 18 or lower
```

**D. Upscaling Algorithm**

```typescript
// In scaling-filter.ts
const filter = `scale=${width}:${height}:flags=lanczos`;
//                                         ^^^^^^^^^^^
// Lanczos is highest quality
// Other options: bicubic, bilinear, neighbor
```

---

## Success Metrics

### How to Know It's Working

**Functional Success:**

- ✅ Exports complete without errors
- ✅ Progress bar moves smoothly
- ✅ All effects render correctly
- ✅ Temp files clean up automatically
- ✅ Cancellation works at both stages

**Quality Success:**

- ✅ Output quality equals or exceeds FFmpeg-only
- ✅ Zoom animations are smooth with easing
- ✅ Background compositing looks professional
- ✅ No visual artifacts or glitches

**Performance Success:**

- ✅ First export: <2 minutes for 30s video
- ✅ Subsequent exports: <1.5 minutes (cache helps)
- ✅ App remains responsive during export
- ✅ Memory usage stays reasonable (<2GB)

**User Experience Success:**

- ✅ Clear progress indication
- ✅ Helpful error messages
- ✅ Cancellation is immediate
- ✅ No manual cleanup needed

### Comparison Benchmarks

**Before (FFmpeg Only):**

```
30-second video with background + zoom:
- Export time: 45-60 seconds
- Quality: Good (linear zoom interpolation)
- Complexity: High (complex filter strings)
- Maintainability: Low (hard to modify effects)
```

**After (Remotion + FFmpeg):**

```
30-second video with background + zoom:
- Export time: 60-90 seconds (slightly slower)
- Quality: Excellent (smooth easing curves)
- Complexity: Medium (React components)
- Maintainability: High (easy to add/modify effects)
```

**Trade-off Analysis:**

- ⏱️ 30% slower export times
- ✨ 100% better animation quality
- 🛠️ 300% easier maintenance
- 🚀 Unlimited future potential

**Verdict:** The trade-off is worth it for the quality and maintainability gains.

---

## Next Steps After Implementation

### Immediate (Week 1)

1. ✅ Get basic pipeline working
2. ✅ Test with real projects
3. ✅ Fix critical bugs
4. ✅ Gather user feedback

### Short-term (Month 1)

1. Add cursor animations in Remotion
2. Implement click effect animations
3. Add text overlay support
4. Optimize performance

### Medium-term (Months 2-3)

1. Add transition effects between clips
2. Implement motion blur
3. Add audio visualization
4. Create effect presets

### Long-term (Future)

1. Template system (intro/outro templates)
2. Advanced effects (particles, masks, tracking)
3. Real-time preview of effects
4. Cloud rendering support

---

## Conclusion

This implementation plan transforms your video export pipeline from a single-stage FFmpeg process to a sophisticated two-stage compositor:

**Key Achievements:**

1. ✅ Remotion handles visual composition (Stage 1)
2. ✅ FFmpeg handles post-processing (Stage 2)
3. ✅ No UI changes needed
4. ✅ No new config files
5. ✅ Clean, maintainable architecture

**Why This Matters:**

- Better quality output
- Smoother animations
- Easier to add features
- More professional results

**The Path Forward:**
Follow this plan phase by phase, test thoroughly, and you'll have a production-ready compositor that can grow with your app's needs.

Good luck with the implementation! 🚀
