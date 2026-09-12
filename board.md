# recso board

The project board. Plain markdown, so it works with no tooling at all — but
`pnpm board` gives you a drag-and-drop view of this exact file, and
`pnpm board:add` files a card without leaving the terminal.

The format is the whole spec: `##` is a column, `###` is a card, a line of
backticked words under the title is its tags, everything after that is the body.
Add a `##` heading and you have a new column. Hand-edit freely; the board reads
what is here rather than keeping its own copy.

This is deliberately shallow. [docs/ENGINE-BACKLOG.md](docs/ENGINE-BACKLOG.md)
is where the reasoning lives — why a thing is wrong, what was tried, what a fix
would cost. Cards link into it. Do not move that prose here; a board is for
knowing what is open, not for remembering why.

## Inbox

_Anything filed in a hurry lands here. Sort it into Backlog when you next look._

## Backlog

### pause button not working

`bug`

Pause button is not working incidentally if pause button doesnt work then that means there is no video recovery either or no way to start the video from where it was being recorded

### Recording FPS and compression settings are not reflected in the output

`recorder` `bug` `quality`

A 1080p high-quality recording configured for 30fps was written as 60fps at
about 5Mbps. A 4K60 lossless recording was only about 10Mbps, even though 4K
contains four times as many pixels as 1080p and the lossless preset should
increase the bitrate substantially rather than merely doubling it.

Audit how the requested frame rate and quality preset reach the native encoder,
then make the resulting file metadata and bitrate scale with those settings.
Add coverage for at least 1080p30 high quality and 4K60 lossless, including
assertions for the output frame rate and a sensible bitrate/quality relationship.

### Audio in playback, and the clock inversion it forces

`engine` `feature` `big`

Export has sound — decode, mix, cut-aware placement, an AAC stream, covered by
`pnpm engine:audio`. Playback does not, and it is the harder half: audio has to
become the master clock, and `Clock` currently free-runs on the wall clock with
the picture following it. Inverting that is a rework of the thing the whole
player is built around.

### GOP length is not controllable, so exact seek costs 170–280ms

`engine` `perf` `big`

The only large number left in the system — every per-frame cost is already
sub-millisecond. `windows-capture`'s `VideoSettingsBuilder` builds a WinRT
`VideoEncodingProperties` rather than going through CODECAPI, so there is
nowhere to set `CODECAPI_AVEncMPVGOPSize`. Needs an upstream PR, or a SinkWriter
that bypasses the crate for the video leg.

See: docs/ENGINE-BACKLOG.md, "Missing: engine-wide"

### Multiple clips

`engine` `feature` `big`

The model is one source plus one overlay. Cuts and ordering exist, but a second
clip has nowhere to live. Not parity work — neither renderer has ever done this.

### Draw on the screen while recording

`recorder` `feature` `big`

A floating toolbar with markers and highlighters, so a recording can be
annotated as it happens instead of in the edit.

Two windows, not one, and that is the whole design. The strokes go on a
transparent click-through overlay that the capture _does_ pick up -- they have
to end up in the file. The toolbar that draws them must not, or every recording
opens with a picture of its own controls.

Windows can do exactly that: `SetWindowDisplayAffinity(hwnd,
WDA_EXCLUDEFROMCAPTURE)` hides a window from screen capture while leaving it on
screen, and it holds for Windows.Graphics.Capture, which is what the recorder
uses. Electron exposes it as `win.setContentProtection(true)`, so neither half
needs native code.

Open questions: whether strokes persist, fade, or are undoable; whether they are
burnt into the capture or recorded as timed vector data the editor could
re-render (much better, considerably more work); and what happens to them when
the editor zooms, since a burnt-in stroke zooms with the pixels and a vector one
would have to be told not to.

### `stop()` does not describe the camera sidecar

`recorder` `gap`

Only the screen track returns a `RecordingMediaInfo`, so the camera's dimensions
and aspect ratio still come from opening the file — the exact demux the metadata
work existed to avoid. No longer blocking anything now that the engine fits the
camera itself, but anything JS-side wanting the aspect ratio before the engine
is involved still pays for it.

### `stop()` does not report file size or frames dropped

`recorder` `gap`

Geometry, duration and frame count are described at capture time; these two are
not. Dropped frames in particular are only visible in the recorder's own logs,
which is the one place nobody looks.

### Interleave audio instead of writing sidecars

`recorder` `feature`

System audio and the microphone are written beside the recording rather than
muxed in. Interleaving is the goal; keep the sidecar as an option for callers
that do not want the audio at all.

### Frame cache is pool-depth only

`engine` `perf`

18 slots, so scrubbing backwards a second still costs a seek — and a seek is the
170–280ms above. These two compound: fix either and scrubbing improves.

### Presentation is an IPC round trip per frame

`engine` `perf`

About 3ms. Fine at 30fps, will not hold at 4K120.

### BT.709 studio swing is assumed

`engine` `gap`

No BT.601, no full range, no HDR. Real files carry this in metadata and the
engine ignores it, so a full-range source comes out with crushed blacks and
clipped whites and nothing says why.

### Windows and D3D11 only

`engine` `gap` `big`

Everything under `velocity/src/engine/` is `#[cfg(windows)]`. The crate still
builds elsewhere without it, so this is a missing backend rather than a broken
build — but the app ships for macOS and Linux and they get the Canvas2D path.

### Only one frame sink can be bound at a time

`engine` `gap`

The dev harness binds its own canvas, so the harness and an editor preview
cannot both be live. Annoying exactly when you are debugging the preview.

### Prototype leftovers in the napi surface

`engine` `chore`

`Pipeline`, `TestPatternSource` and `PatternEncoder` are still exported. Dead,
and they make the surface look bigger than it is.

### `GpuFrameSource` is constructed by nothing

`engine` `chore`

It implements `FrameVideoSource`, the seam the compositor would pull from. The
preview went the other way in the end and drives the engine directly, so this is
a road not taken rather than a gap. Delete it or document it as such.

### `engine:player:open-recording` has no renderer caller

`app` `chore`

Takes a recording id, reads stored metadata, opens with no probe. Wired through
IPC and preload — and no renderer calls it, so the preview still opens by path
and pays for a probe it does not need.

### README says the GPU engine is not wired into the editor

`docs` `bug`

`README.md` lists it as "parallel, not yet wired into the editor". The backlog's
integration section says recording, preview and export all run through the
engine by default. One of these is three months out of date and it is not the
backlog.

## In progress

_Move a card here when you start it. Nothing is claimed right now._

### Solve the preview flickering issue

`bug`

when playing a video the editor isnt actually optimised such that the preview starts flickering back and forth. I dont know the exact amount but roughly it moves 1 frame forward and 2 frames backward which needs to be solved

## Parked

### Webcam overlay can lead by up to one camera frame

`engine` `known`

`advance_webcam` stages the camera frame that overshoots the target rather than
dropping it, so the overlay can be one camera interval ahead — about 33ms at
30fps. Deliberate: the alternative discards camera frames whenever the screen
ticks faster than the camera, which on a busy screen is most of them. Invisible
on an overlay.

Becomes a real bug if the webcam is ever composited full-frame, or once lip sync
starts mattering — i.e. when playback audio lands.

### Recordings made before the H.264 switch have an undecodable camera track

`recorder` `wontfix`

The camera sidecar was HEVC until `69bc00a`. The screen track opens and the
camera beside it fails with `0xC00D5212` — no HEVC decoder MFT on a stock
Windows install, even though the GPU itself can decode it. Listed so the symptom
is recognisable, not because it is fixable. Those recordings still play through
the editor's `<video>` path, which goes via Chromium.

## Done

### Harden the shared-texture application renderer

`app` `security` `bug`

Electron does not expose `sharedTexture` to sandboxed preloads, so the editor
window keeps `sandbox: false` to preserve the native shader → shared D3D11
texture → preview path. The page still has context isolation on, Node integration
off, webviews off, a narrow bridge, and web security on in production. Windows
that do not own a shared-texture receiver should remain sandboxed.

### Native metadata probing without a whole-file read

`recorder` `perf`

Crash recovery and old recordings now open `velocity.VideoDecoder` and read its
container metadata. No recording-sized Buffer or Blob is created in JavaScript.
The finalize readability check uses the same native decoder.

### Retire the Mediabunny export path

`editor` `chore`

The Canvas2D/Mediabunny exporter, its adapters, and the package dependency are
gone. Export planning now either hands a complete composition to the native
engine or names an unsupported feature; it never silently falls back to a
renderer-memory path.

### Guard the native export cutover with real seams

`engine` `chore`

Vitest covers window security, export planning helpers, native audio-sidecar
alignment, and the renderer-to-engine call. A deterministic Electron check now
drives the actual main-process export service through the native addon, writes
an MP4, reopens it, and verifies range and geometry. It joins the existing
1,650 Rust tests and native cut/export checks in `pnpm check:engine-cutover`.

### Webcam shadows — the last thing the engine could not draw

`engine` `feature`

Analytic rather than a blur pass: the shape is already an exact distance field,
and blurring a hard edge is the same as softening the step across it, so a
shadow is one extra quad with no scratch target. Matches canvas's own Gaussian
to within a couple of percent.

### Parity with the Canvas2D compositor

`engine` `feature` `big`

`unsupportedFeatures` returns an empty list and nothing routes an export back to
the Canvas2D path. Webcam cuts, webcam zoom regions, layer ordering and legacy
zoom keyframes were the last four that did.

### Per-event cursor bitmaps, click animations and the smear

`engine` `feature`

The structural one. A table of bitmaps uploaded once with an `image_id` per
sample, so cost tracks distinct shapes rather than sample count. Region
overrides and I-beam detection then needed no engine change at all — both reduce
to choosing a different id. Clicks and the smear did need work, since they
change the pointer's rect rather than its bitmap.

### Export carries the webcam and cursor

`engine` `bug`

`run_export` built its own chain and never attached the overlay layers, so an
export got desktop plus grading and the camera silently vanished — while the
preview looked completely correct. Verified by `pnpm engine:export-composition`,
which exports the same recording bare and composited and compares pixels: a
preview-side check cannot catch this, because the failure _is_ the two paths
disagreeing.

### Cursor position resolves against display size, not coded size

`engine` `bug`

`Decoder.display_width` was never the display width — it was `MF_MT_FRAME_SIZE`,
which on a macroblock-padded file is the coded size. Now reads
`MF_MT_MINIMUM_DISPLAY_APERTURE` and exposes `display_size` beside `coded_size`.
Fell out of it: exports are the visible size instead of carrying eight rows of
decoder scratch.

### The webcam is fitted to its box, not stretched

`engine` `bug`

`WebcamLayout` gained a `FitMode` — `cover` (the default, crops through UVs),
`contain`, and `stretch` for the old behaviour. The engine owns it because the
engine is the only side that knows the camera's real resolution.

### Per-layer grading

`engine` `feature`

`EffectParams` moved off `RenderChain` onto each layer. Kills the "does the
grade sit above or below the overlays" question rather than answering it — the
screen and the camera are two sensors with two exposures, and one global grade
can only trade one against the other.

### Audio in export

`engine` `feature`

Decode, mix, cut-aware placement and an AAC stream. Covered by
`pnpm engine:audio`.

### Backgrounds, zoom regions and cuts

`engine` `editor` `feature`

Flat colour direct; gradients, patterns and images rasterised by the caller. The
animated zoom/pan timeline, and source↔composition mapping with cut-aware audio.
These were the three items `tasks.md` still listed as upcoming.

### Grow the Rust suite from 167 to 1601 tests

`engine` `chore`
