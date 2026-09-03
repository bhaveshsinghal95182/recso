# Engine ↔ editor feature map

What the editor's compositor and its mediabunny export actually do, against what
the GPU engine has, and what it would take to put the engine underneath them.

Read [ENGINE.md](ENGINE.md) first for how the engine works.
[ENGINE-BACKLOG.md](ENGINE-BACKLOG.md) is what is broken or missing _inside_ the
engine; this is the different question of what the engine would have to grow
before it can replace anything.

Sources: `src/ui/screens/editor/engine/functions/` (the compositor) and
`src/ui/screens/editor/engine/export-pipeline/` (the mediabunny export).

---

## First, a naming correction

The backlog calls the editor's compositor "the Pixi compositor". It is not one.

`renderCompositionFrame` in [`functions/render.ts`](../src/ui/screens/editor/engine/functions/render.ts)
is **Canvas2D** — every layer is `ctx.fill`, `ctx.clip`, `ctx.drawImage` against
a `CanvasRenderingContext2D`. Pixi appears exactly once, as `PixiPreviewSurface`
in [`adapters.ts`](../src/ui/screens/editor/engine/adapters.ts), a sprite that
blits the finished canvas to screen — and the preview session bypasses even
that, with the comment _"render directly to the visible preview canvas to avoid
WebGL/Pixi runtime failures"_.

This matters more than pedantry. A Pixi compositor would be a scene graph on the
GPU, and swapping a GPU backend under it is a plausible afternoon. A Canvas2D
compositor is an immediate-mode CPU rasteriser, and the engine is not a faster
version of it — it is a different shape.

There are also two things named "engine" in this repo: the editor's
`CompositionEngine` (Canvas2D, in `src/ui/screens/editor/engine/`) and velocity's
GPU engine (Rust/D3D11, in `velocity/src/engine/`). This document says
**compositor** for the first and **engine** for the second throughout.

---

> **Status.** Steps 1-4 of the order at the bottom are done, plus zoom and cuts: the canvas is no
> longer tied to the source, backgrounds and the video's own rect/radius/border
> exist, and grading is per-layer. The tables below are marked accordingly. What
> is left is the timeline, per-event cursors and audio -- and the integration
> itself, which is now the next thing rather than a thing waiting on the engine.

---

## The structural gap, before the feature list

Most of the table below is downstream of one thing, so it is worth stating on
its own: **the two have different coordinate models.**

The engine renders **source-sized frames**. `RenderChain` is constructed at the
decoder's coded size, every render target in it is that size, and the webcam and
cursor are drawn in that space. A frame in, the same-sized frame out.

The compositor renders **a canvas the video sits inside**. `computeVideoLayout`
places the recording as an inset rectangle — scaled by `video.scale`, centred,
with `canvasPadding` clear on each side — over a background that fills the rest.
The video is one layer among four, not the frame itself.

```
engine                          compositor
┌──────────────┐                ┌────────────────────┐
│              │                │   background       │
│   video      │                │  ┌──────────────┐  │
│  + overlays  │                │  │   video      │  │
│              │                │  │  + cursor    │  │
└──────────────┘                │  └──────────────┘  │
                                │            webcam  │
canvas == source                └────────────────────┘
                                canvas != source
```

Once the canvas can be bigger than the video, a pile of features become
_possible_ that are not even expressible today: backgrounds, padding, the video
layer's own rounded corners and border, and zoom (which is a canvas transform
around a pivot). None of those are "add a shader" — they need the chain to
render into a destination it does not currently own the size of.

**So the first integration task is not a feature at all.** It is giving
`RenderChain` a canvas size distinct from the source size, and a video rect
inside it. Everything in the "canvas & layout" and "background" rows depends on
it, and so does zoom.

---

## Feature table

**engine** columns: `yes` = works, `partial` = the mechanism exists but not the
feature, `no` = absent.

### Canvas & layout

| Feature                          | Compositor | Engine  | Notes                                                                      |
| -------------------------------- | ---------- | ------- | -------------------------------------------------------------------------- |
| Canvas larger than the video     | yes        | **yes** | `canvasWidth`/`canvasHeight` when opening. Fixed for the player's life.    |
| Canvas padding (`canvasPadding`) | yes        | **yes** | Resolved caller-side into the `setLayout` rect, like the webcam's anchor.  |
| Video scale / centring           | yes        | **yes** | ditto — the engine takes the resolved rect, not the ratio.                 |
| Video border radius              | yes        | **yes** | The same SDF mask the webcam uses, now pointed at the video quad.          |
| Video border (width, colour)     | yes        | **yes** | `ps_solid`: the same rounded rect grown by the width, filled, drawn under. |
| Source crop                      | yes        | **yes** | UVs on the video quad; also moves the cursor and hides it outside.         |
| Explicit layout override         | yes        | n/a     | `config.layout` short-circuits the computed layout.                        |

### Background

| Feature                        | Compositor | Engine        | Notes                                            |
| ------------------------------ | ---------- | ------------- | ------------------------------------------------ |
| Solid colour                   | yes        | **yes**       | A `ClearRenderTargetView`, so it costs nothing.  |
| Linear gradient (angle, stops) | yes        | **via image** | Rasterised caller-side and uploaded.             |
| Radial gradient (cx/cy/rx/ry)  | yes        | **via image** | ditto                                            |
| Cross-hatch pattern            | yes        | **via image** | ditto                                            |
| Image                          | yes        | **yes**       | Tightly packed RGBA8, stretched over the canvas. |
| Precomposed once for export    | yes        | **yes**       | Uploaded on change, not per frame.               |

Backgrounds are static for a whole export, so the engine takes one texture
rather than growing a shader family. Reimplementing four generators in HLSL
would buy nothing over letting the caller rasterise once — and would be four
more things that have to match the Canvas2D versions pixel for pixel. Solid
colour is the exception, because a clear is free.

### Video layer

| Feature          | Compositor                 | Engine | Notes                                                         |
| ---------------- | -------------------------- | ------ | ------------------------------------------------------------- |
| Hardware decode  | via `<video>` / mediabunny | yes    | The engine's whole reason to exist.                           |
| Brightness       | **no**                     | yes    | Engine-only, and still with no UI. See "the other way" below. |
| Contrast         | **no**                     | yes    | ditto                                                         |
| Saturation       | **no**                     | yes    | ditto                                                         |
| Per-layer grades | **no**                     | yes    | Video and webcam grade separately; the cursor never grades.   |

### Webcam overlay

| Feature                               | Compositor | Engine     | Notes                                                               |
| ------------------------------------- | ---------- | ---------- | ------------------------------------------------------------------- |
| Anchor (3×3 grid)                     | yes        | via caller | `webcam-anchor.ts` resolves to pixels; the engine takes pixels.     |
| Height ratio + margin                 | yes        | via caller | Same — resolved on the JS side by design.                           |
| Aspect-ratio-driven box               | yes        | via caller | The box comes from config `aspectRatio`, not the camera's.          |
| Fit without distortion                | yes        | yes        | Both centre-crop. See "already agreed" below.                       |
| Shape: circle                         | yes        | yes        | `OverlayShape::Ellipse`.                                            |
| Shape: rect landscape/portrait/square | yes        | yes        | All three are a rect with an aspect ratio the caller picks.         |
| Corner radius                         | yes        | yes        |                                                                     |
| Opacity                               | yes        | yes        |                                                                     |
| Border (width, colour)                | yes        | **yes**    | The same `ps_solid` quad the video layer's border uses.             |
| Shadows (multi-layer)                 | yes        | **no**     | `shadows[]` — offset, blur, colour, each its own `ctx.shadow*`.     |
| Webcam cuts (hide by region)          | yes        | **no**     | Needs a timeline model.                                             |
| Zoom-driven height override           | yes        | **no**     | `webcamZoomRegions` override `heightRatio` for a span.              |
| Zoom-driven full-canvas mode          | yes        | **no**     | Blends box → full canvas, dropping radius/border/shadow as it goes. |

### Cursor

| Feature                                    | Compositor | Engine | Notes                                                                      |
| ------------------------------------------ | ---------- | ------ | -------------------------------------------------------------------------- |
| Position track                             | yes        | yes    | Both hold the last sample rather than interpolating.                       |
| Hotspot                                    | yes        | yes    |                                                                            |
| Size                                       | yes        | yes    | Compositor scales by source-to-canvas ratio too; engine takes pixels.      |
| Opacity                                    | **no**     | yes    | Engine-only.                                                               |
| Visibility flag                            | yes        | yes    |                                                                            |
| Built-in glyphs (arrow, crosshair, I-beam) | yes        | **no** | Drawn as paths. The engine takes a bitmap, so these rasterise caller-side. |
| Custom image                               | yes        | yes    |                                                                            |
| **Per-event bitmap**                       | yes        | **no** | `cursorDataUrl` per sample vs one global sprite. Structural — see below.   |
| Region overrides by time                   | yes        | **no** | `cursorRegionOverrides` swap the image for a span.                         |
| I-beam detection by handle                 | yes        | **no** | `KNOWN_IBEAM_CURSOR_HANDLES` special case.                                 |
| Click animations                           | yes        | **no** | Scale + duration on click events.                                          |
| Motion blur                                | yes        | **no** | Trail between samples.                                                     |
| Speed-scaled motion blur                   | yes        | **no** | Intensity from sample-to-sample speed.                                     |

### Timeline

| Feature                         | Compositor | Engine  | Notes                                                    |
| ------------------------------- | ---------- | ------- | -------------------------------------------------------- |
| Cuts                            | yes        | **yes** | `engine/cuts.rs`; source ↔ composition, both directions. |
| Zoom regions (ease in/out)      | yes        | **yes** | `engine/zoom.rs`; smoothstep, matching the compositor's. |
| Focal keyframes within a region | yes        | **yes** | Linear pan between them, like the compositor.            |
| Legacy zoom keyframes           | yes        | **no**  | The `computeZoomState` fallback. Regions supersede it.   |
| Layer reordering                | yes        | **no**  | `layerStates` — the four layers are a user-ordered list. |
| Per-layer `base`/`zoomed` space | yes        | **no**  | Decides which layers the zoom transform applies to.      |
| Multiple clips                  | **no**     | **no**  | Neither has one. Worth knowing before designing for it.  |

### Audio

| Feature                  | Export pipeline | Engine | Notes                                                  |
| ------------------------ | --------------- | ------ | ------------------------------------------------------ |
| Screen / system audio    | yes             | **no** | `audio-mix.ts`.                                        |
| Webcam audio             | yes             | **no** | Remuxed and mixed in.                                  |
| Cut-aware audio timeline | yes             | **no** | Audio follows the same cut mapping as video.           |
| Audio as master clock    | **no**          | **no** | Neither does this. The engine's `Clock` is video-only. |

---

## Two things flowing the other way

Worth calling out, because a parity list invites the assumption that everything
is missing in one direction.

**Grading is engine-only.** `EffectParams` — brightness, contrast, saturation —
has no counterpart in the compositor at all. `CompositionConfig` has no colour
fields, and the only UI that drives grading is the dev harness at
`src/ui/screens/engine-harness/`. So backlog bug 2, the argument about whether
the grade should reach the overlays, was about a feature no user can currently
get to. It is now per-layer, which dissolved the question — but the point
stands: **grading still needs a UI before it needs anything else.**

**Cursor opacity is engine-only** too, for the same reason — the compositor's
cursor config has a size but no alpha.

---

## Where the two already agree

Two things are worth recording as settled, because they cost nothing to keep
aligned and are expensive to discover are misaligned.

**Webcam fit.** `HtmlVideoCoverFrameSource.draw` centre-crops the camera to the
target box, with the comment _"center-crop source to target aspect ratio to
avoid webcam stretching"_. That is exactly `FitMode::Cover`, which the engine
now defaults to after backlog bug 4. Independently arrived at, same answer.

**Cursor default size.** Both use 22px as the base, and both say so in a comment
naming the other.

**Placement lives on the JS side.** The anchor grid, height ratio and margin all
resolve to pixels before the engine sees them, so there is one placement formula
in the app rather than two that have to agree. `webcam-anchor.ts` says this
explicitly and the engine's `set_webcam_layout` docs match. Keep it that way.

---

## The four structural problems

Not features. These need a design decision before any code.

**1. Canvas ≠ source.** ~~Blocks background, padding, video border and radius,
and zoom.~~ **Done.** The chain takes a canvas size alongside the source's, and
every layer including the video is now a quad placed on it. The canvas is fixed
when a player opens, because its size is the size of the textures already handed
to Chromium; the video's _rect within_ it moves freely instead. Cursor positions
resolve against that rect, so the pointer follows the video when it is inset.

Zoom still needs a transform on top of this, but it now has a coordinate system
to be a transform _of_.

**2. Per-event cursor bitmaps.** recso's track carries a `cursorDataUrl` _per
sample_ — the pointer changes as it moves over a text field, a link, a resize
handle. The engine has one `SpriteTexture` for the whole track. Supporting this
means a texture cache keyed by image, or an atlas, not another field. Everything
else in the cursor row is easy by comparison; this one is a data structure.

**3. No timeline model.** ~~Cuts, zoom regions~~ and layer ordering were all the
same missing thing: the engine played one source linearly with no representation
of "the composition" as distinct from "the file".

Zoom and cuts are done. Zoom needed no transform after all -- every layer is a
rect, and scaling an axis-aligned rect about a pivot is exactly what the
compositor's canvas transform does to it. Cuts gave the engine the
source/composition split it was missing, which is the representation the rest of
the timeline work needs.

Layer ordering is what is left here, and it is small by comparison: the four
draws are already separate calls.

**4. Audio.** The engine has none, anywhere, and audio has to become the master
clock eventually. `Clock` is video-only and will have to slave to it. The longer
this waits the more there is to redo — every timeline decision above is easier to
make with audio in mind than to retrofit around.

---

## Also worth knowing

**The mediabunny export reads the whole file into memory.**
`run-engine-canvas-export.ts` does `await response.blob()` on the source before
handing it to `BlobSource`. That is the 5GB ceiling in `todo.md`. The engine's
exporter streams through a Media Foundation source reader and has no equivalent
limit, so this is a reason to move export to the engine that is independent of
speed or fidelity.

**Two export paths already coexist**, the engine's and mediabunny's, with
nothing choosing between them. The engine's cannot yet produce a composed frame
(no background, no zoom, no cuts, no audio), so mediabunny's is the only one
that can currently export a real project.

---

## Proposed order

Sequenced so each step is independently shippable and nothing is wasted.

1. ~~**Canvas ≠ source.**~~ **Done.** Every layer is a quad on a canvas the
   video is placed into.
2. ~~**Background as one texture.**~~ **Done.** Solid via clear, everything else
   as an uploaded image.
3. ~~**Video border and radius.**~~ **Done**, plus the webcam's border, which
   fell out of the same `ps_solid` quad.
4. ~~**Per-layer grading.**~~ **Done.** The grade moved into the overlay
   constant buffer, so it costs no pass and every quad carries its own.
5. **Preview integration behind a flag.** `GpuFrameSource` already implements
   `FrameVideoSource`. The engine can now produce a composed frame for a project
   with no zoom, cuts or per-event cursors — enough to run it side by side
   against the compositor and compare. **This is the next thing.**
6. **Timeline model:** ~~zoom~~ **done** -- every layer is a rect, and scaling
   an axis-aligned rect about a pivot is exactly what the compositor's canvas
   transform does to it, so no transform stack was needed. Cuts next (a
   source↔composition mapping the engine already almost has in its seek path),
   then layer ordering.
7. **Per-event cursor bitmaps**, then the cursor effects that depend on them.
8. **Audio**, and the clock rework it forces.

Steps 1–4 were engine-internal and changed nothing the user sees. Step 5 is the
first point where any of this is reachable from the app, and it is deliberately
placed where the engine can finally render a frame worth comparing.
