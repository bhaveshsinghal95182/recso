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

> **Status.** The engine draws every composition the editor can describe, bar
> one cosmetic detail. Recording, preview and export all run through it by
> default, and nothing routes an export back to the Canvas2D path any more --
> webcam cuts, webcam zoom regions, layer ordering and legacy zoom keyframes
> were the four that did, and they are done.
>
> Webcam shadows are what is left, and they are cosmetic: the engine draws the
> box, its radius and its border, and skips the blur behind it. That is reported
> rather than refused over, because refusing meant the engine never ran at all
> for anyone with a camera -- the default style carries three blurred layers.
>
> What remains is not parity but the things neither path has: audio as the
> master clock, and multiple clips. Then the test suite, then mediabunny goes.

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

| Feature                               | Compositor | Engine     | Notes                                                              |
| ------------------------------------- | ---------- | ---------- | ------------------------------------------------------------------ |
| Anchor (3×3 grid)                     | yes        | via caller | `webcam-anchor.ts` resolves to pixels; the engine takes pixels.    |
| Height ratio + margin                 | yes        | via caller | Same — resolved on the JS side by design.                          |
| Aspect-ratio-driven box               | yes        | via caller | The box comes from config `aspectRatio`, not the camera's.         |
| Fit without distortion                | yes        | yes        | Both centre-crop. See "already agreed" below.                      |
| Shape: circle                         | yes        | yes        | `OverlayShape::Ellipse`.                                           |
| Shape: rect landscape/portrait/square | yes        | yes        | All three are a rect with an aspect ratio the caller picks.        |
| Corner radius                         | yes        | yes        |                                                                    |
| Opacity                               | yes        | yes        |                                                                    |
| Border (width, colour)                | yes        | **yes**    | The same `ps_solid` quad the video layer's border uses.            |
| Shadows (multi-layer)                 | yes        | **no**     | `shadows[]` — offset, blur, colour, each its own `ctx.shadow*`.    |
| ~~Webcam cuts (hide by region)~~      | yes        | yes        | `HiddenSpans`, staged per slot like the cursor's rect.             |
| ~~Zoom-driven height override~~       | yes        | yes        | The caller lays out each region's box; the engine eases between.   |
| ~~Zoom-driven full-canvas mode~~      | yes        | yes        | Blends box → full canvas, dissolving radius and border on the way. |

### Cursor

| Feature                                    | Compositor | Engine  | Notes                                                                            |
| ------------------------------------------ | ---------- | ------- | -------------------------------------------------------------------------------- |
| Position track                             | yes        | yes     | Both hold the last sample rather than interpolating.                             |
| Hotspot                                    | yes        | yes     |                                                                                  |
| Size                                       | yes        | yes     | Compositor scales by source-to-canvas ratio too; engine takes pixels.            |
| Opacity                                    | **no**     | yes     | Engine-only.                                                                     |
| Visibility flag                            | yes        | yes     |                                                                                  |
| Built-in glyphs (arrow, crosshair, I-beam) | yes        | yes     | Drawn as paths, then rasterised caller-side with the compositor's own functions. |
| Custom image                               | yes        | yes     |                                                                                  |
| **Per-event bitmap**                       | yes        | **yes** | A deduped bitmap table; each sample carries an index into it.                    |
| Region overrides by time                   | yes        | yes     | A table entry, plus a sample injected at each boundary. See below.               |
| I-beam detection by handle                 | yes        | yes     | The same known-handle check, choosing a table entry.                             |
| Click animations                           | **no**     | yes     | Compositor carries the settings and never reads them. Engine pops the pointer.   |
| Cursor smear                               | partial    | yes     | Compositor draws a blur trail; the engine stretches the pointer. See below.      |

### Timeline

| Feature                         | Compositor | Engine  | Notes                                                                |
| ------------------------------- | ---------- | ------- | -------------------------------------------------------------------- |
| Cuts                            | yes        | **yes** | `engine/cuts.rs`; source ↔ composition, both directions.             |
| Zoom regions (ease in/out)      | yes        | **yes** | `engine/zoom.rs`; smoothstep, matching the compositor's.             |
| Focal keyframes within a region | yes        | **yes** | Linear pan between them, like the compositor.                        |
| ~~Legacy zoom keyframes~~       | yes        | yes     | Converted to regions on the way in; one zoom model.                  |
| ~~Layer reordering~~            | yes        | yes     | `layerStates` — the three drawable layers, background is the canvas. |
| Per-layer `base`/`zoomed` space | yes        | **no**  | Decides which layers the zoom transform applies to.                  |
| Multiple clips                  | **no**     | **no**  | Neither has one. Worth knowing before designing for it.              |

### Audio

| Feature                  | Export pipeline | Engine  | Notes                                                                |
| ------------------------ | --------------- | ------- | -------------------------------------------------------------------- |
| Screen / system audio    | yes             | **yes** | Any number of sources, each with its own offset.                     |
| Webcam audio             | yes             | **yes** | Same mechanism; it is just another source.                           |
| Cut-aware audio timeline | yes             | **yes** | Chunks are placed in composition time; cut ones are dropped.         |
| Trimmed exports          | yes             | **yes** | `skip_to` seeks every source to the export's start.                  |
| ~~Audio in preview~~     | n/a             | yes     | An `<audio>` element on the recording, seeked to the engine's clock. |
| Audio as master clock    | **no**          | **no**  | Neither does this. `Clock` is video-only.                            |
| Loudness normalisation   | yes             | **no**  | The mix is clamped on the way to 16-bit, not peak-normalised.        |

Audio landed export-first on purpose: it is what mediabunny was still needed
for, and an export either has the sound or it does not, which is a far easier
thing to be sure about than playback sync.

Verified by `pnpm engine:audio`, which exports the same recording with and
without sources and probes both files. The failure it guards against is quiet in
both senses -- an export with a silent audio track looks completely normal until
someone plays it with the volume up.

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

## The cursor smear

Not motion blur, and the difference is the whole feature. The compositor draws a
blur trail: copies of the pointer along the path between two samples, fading
out. What the engine draws is the animator's smear -- the pointer itself
stretched along its direction of travel, one shape, elongated by how fast it is
moving, snapping back when it stops.

Blur says "this is a photograph of something fast". Smear says "this is drawn,
and it is moving". A pointer is a drawn object composited on top of a
recording, so the second is the honest read.

It is also cheaper. A blur trail is many draws of the same sprite; the smear is
one draw. The quad is the bounding box of the pointer and the pointer swept
backwards, `uv_rect` maps that box back onto the sprite so uv 0..1 still means
"the pointer", and `ps_smear` marches each pixel _forward_ along the travel
vector, accumulating what the pointer looked like as it passed. A pixel behind
the head sees the pointer that was there a moment ago; the head sees only
itself, so it stays crisp while the tail streaks out.

Two details do the work. Alpha is the strongest weighted tap rather than the sum
-- the smear is the union of the shape as it swept, and summing would make a
fast pointer, whose taps all land on the same few texels, more opaque than the
pointer itself. And the weight falls off quadratically, which is what puts the
heavy blur at the back and leaves the front sharp.

**It is capped.** Speed has no upper bound; a flick of the mouse crosses a 4K
screen in a couple of frames, and an uncapped smear is a streak from one edge to
the other, which stops reading as a pointer at all. Four times the pointer's
height is long enough to look fast and short enough to still look like the shape
it came from.

**It snaps rather than eases.** The track holds its last sample forever, so the
velocity that reached it is still sitting there minutes after the pointer
stopped -- a streak frozen on screen. Instead the motion is only believed for
about as long as it took to arrive: if the next sample has not turned up by then
the pointer has stopped, and the smear is gone in one frame. Easing out of
something that already ended is the wrong shape for the problem; a stopped
pointer is not slowing down, it is stopped.

It rides on the editor's existing `showMotionBlur` switch. That setting already
means "make fast pointer movement look fast", and the engine answers it with a
smear instead of a trail of ghosted copies -- same control, different mechanism,
nothing in the UI to change.

## Click animations

The pointer pops when clicked: a fast punch out over the first 18% of the
duration and a slower settle back over the rest. Holding it at full size for the
whole 500ms would read as the cursor having changed size, and an equal rise and
fall reads as breathing; the asymmetry is what makes it look struck.

The scale is taken about the hotspot, not the rect's centre, so the tip stays on
the pixel that was clicked while everything around it grows.

The click rides on the sample -- `click: true` -- so a cut that drops the moment
drops the click with it, but it is resolved against a _separate list_ of click
times pulled out of the track. That distinction is the whole design. A click is
an impulse and a sample is a state: the engine holds the last sample until the
next one, so if the pop were a property of the sample in effect, the mousemove
ten milliseconds later would end it. That is a drag, and it is exactly when a
click most needs to be visible.

The same reasoning is why a sample injected at an override boundary explicitly
clears the flag rather than inheriting it -- copying a held click would fire the
pop again at a time the user never clicked.

## Before the cutover: a real test suite

The engine is about to become the only path. Today there are two, and every bug
found so far has been survivable because the other one still worked — the export
that stalled at 79%, the preview that jittered, the webcam that opened with no
camera. After mediabunny is deleted there is no other one.

That asymmetry is the argument for building the suite _before_ the cutover
rather than after. A test written afterwards documents behaviour; a test written
before removing the fallback is the thing that lets you remove it.

**Scale: 800–900 tests.** Not a target for its own sake — roughly what this
surface costs to cover properly:

| Area                                     | Rough count | Kind                                                     |
| ---------------------------------------- | ----------- | -------------------------------------------------------- |
| Timeline maths: cuts, zoom, focal pans   | 120         | Rust unit. Boundaries and degenerate inputs.             |
| Layout: canvas, fit, anchors, crop       | 120         | Rust unit. Every mode against every aspect ratio.        |
| Audio: mixing, placement, offsets, rates | 100         | Rust unit, plus a few end to end.                        |
| Cursor: sampling, hotspots, overrides    | 90          | Rust unit. The per-event track is a state machine.       |
| Colour: parsing, conversion, ranges      | 60          | Rust unit. BT.601/709, studio and full swing.            |
| Render chain: passes, ordering, state    | 80          | Pixel readback — what a unit test cannot see.            |
| Export: containers, progress, cancel     | 70          | End to end against real files.                           |
| Config mapping: editor to engine         | 100         | TS unit. Every field, including ones nobody sets.        |
| Preview session: lifecycle, transport    | 60          | TS. The React layer, where three bugs have already been. |
| Recorder: geometry, duration, sidecars   | 70          | Mixed.                                                   |
| Regression: one per fixed bug            | 40          | Whatever shape the bug was.                              |

**Where the number comes from**, beyond today's ~115 Rust tests: degenerate
inputs (zero-length clips, single-frame recordings, sources with no audio),
boundaries (a cut at exactly frame zero, a zoom region of zero length, a webcam
box larger than the canvas), and the whole TypeScript side, which has no tests
at all despite being where every bug this week actually lived.

**Two lessons from this branch the suite has to encode.** Screen capture emits
frames only on change, so an idle desktop produces a recording of two frames and
33 milliseconds — fixtures have to be synthetic or deliberately active, and
several checks here have already had to learn that. And a preview that looks
right is not evidence an export is right: the failures that matter most are the
two paths disagreeing, so the checks that catch them have to compare the paths
rather than inspect one.

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

**2. ~~Per-event cursor bitmaps.~~ Done.** recso's track carries a
`cursorDataUrl` _per sample_ — the pointer changes as it moves over a text
field, a link, a resize handle — against the engine's one `SpriteTexture` for
the whole track. It was on this list because it was a data structure rather than
a field.

What it became: a bitmap table uploaded once, and an `image_id` on each sample
indexing into it. The dedupe is the whole trick. A ten minute recording holds
thousands of samples and perhaps a dozen distinct shapes, so keying the table on
the image and sending each one once keeps what crosses the boundary proportional
to the shapes rather than the samples — an image per event would have been
megabytes of the same few kilobytes.

One subtlety that is easy to get wrong: the pointer's rect is resolved at stage
time, and its size and hotspot offset both come from the bitmap. So the slot has
to remember _which_ bitmap it was measured against, not just where the rect was.
Resolving the rect against one shape and drawing it with another puts the tip in
the wrong place, and only on frames that get re-rendered — which is to say, only
when you drag a slider.

Region overrides and I-beam detection then landed on top of it without a single
engine change. Four rules now decide the pointer's shape — an override, the
I-beam handle check, the recorded bitmap, the default — and all four collapse to
the same thing: an index. The engine never learns which rule chose a shape, only
which shape to draw.

There was one place the two paths did not line up on their own. The compositor
asks "what override covers the playhead?" every frame; the engine holds the last
sample until the next one. A stationary pointer produces no events, so an
override beginning while the mouse is still would not appear until it moved —
which is exactly when someone is demonstrating the thing they added the override
for. The fix is to inject a sample at each override boundary, inheriting the held
position since only the shape changes.

Click animations and the smear landed on top of that, and they did need engine
work: they change the pointer's rect rather than its bitmap. The click folds
into the scale the rect is already derived from, and the smear replaces the
sprite draw with a stretched quad and a marching shader. Both are staged with
the frame for the same reason the rect is -- a re-render after a grading change
must put the pointer back the way it was, not the way the playhead is now.

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

**4. Audio as the clock.** Half solved. The engine decodes and mixes audio and
writes it to an export, so the mediabunny path is no longer needed for sound.
What remains is playback: audio has to become the master clock, and `Clock` —
which currently free-runs on the wall clock, with the picture following it — has
to slave to audio instead. That inverts the relationship the whole player is
built around, which is why it is still here rather than in the table above.

---

## Also worth knowing

**mediabunny is being retired.** The engine is the export path; the two are not
going to coexist indefinitely, and nothing new should be added to the mediabunny
side.

The immediate reason is the 5GB ceiling: `run-engine-canvas-export.ts` does
`await response.blob()` on the source before handing it to `BlobSource`, so the
whole recording goes through memory. The engine's exporter streams through a
Media Foundation source reader and has no equivalent limit. That was tracked as
its own bug for a while; it is not a bug to fix, it is a reason the path is
going away.

**What has to land before it can go.** Audio is the whole of it. The engine
export already carries background, layout, zoom, cuts, crop, the webcam and the
cursor -- everything the compositor draws except the items in the tables above.
It has no audio at all, and mediabunny's path is where the microphone, system
audio and camera audio are currently mixed. Until the engine can do that, the
mediabunny exporter is the only one that can produce a finished file.

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
7. ~~**Per-event cursor bitmaps**~~ **done**, and region overrides and I-beam
   detection with them — both were table entries, needing no engine change.
   Click animations and the smear are what remain, and those touch the rect
   rather than the bitmap.
8. ~~**Audio**~~ **half done.** Export has sound: decode, mix, cut-aware
   placement and an AAC stream. Preview does not, and that is the half that
   forces the clock rework — audio has to become the master and `Clock` has to
   slave to it.
9. **The test suite.** See "Before the cutover" above. It belongs before the
   step after it, not after it.
10. **Retire mediabunny.** Delete the second export path, and the `<video>`
    preview with it.

Steps 1–4 were engine-internal and changed nothing the user sees. Step 5 is the
first point where any of this is reachable from the app, and it is deliberately
placed where the engine can finally render a frame worth comparing.
