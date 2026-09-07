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

### GOP length is not controllable, so exact seek costs 170–280ms

`engine` `perf` `big`

The only large number left in the system — every per-frame cost is already
sub-millisecond. `windows-capture`'s `VideoSettingsBuilder` builds a WinRT
`VideoEncodingProperties` rather than going through CODECAPI, so there is
nowhere to set `CODECAPI_AVEncMPVGOPSize`. Needs an upstream PR, or a SinkWriter
that bypasses the crate for the video leg.

See: docs/ENGINE-BACKLOG.md, "Missing: engine-wide"

### Audio in playback, and the clock inversion it forces

`engine` `feature` `big`

Export has sound — decode, mix, cut-aware placement, an AAC stream, covered by
`pnpm engine:audio`. Playback does not, and it is the harder half: audio has to
become the master clock, and `Clock` currently free-runs on the wall clock with
the picture following it. Inverting that is a rework of the thing the whole
player is built around.

### Multiple clips

`engine` `feature` `big`

The model is one source plus one overlay. Cuts and ordering exist, but a second
clip has nowhere to live. Not parity work — neither renderer has ever done this.

### A real test suite before mediabunny goes

`engine` `chore`

The feature map calls this the gate on the cutover: parity is done, so what is
left is proving it stays done. Blocks removing the Canvas2D export path.

See: docs/ENGINE-FEATURE-MAP.md, "Before the cutover: a real test suite"

### Delete the mediabunny export path

`editor` `chore`

Nothing routes an export back to Canvas2D any more and `unsupportedFeatures`
returns empty. Blocked on the test suite above — deleting the fallback before
there is coverage means the engine is the only path and nothing checks it.

### `sandbox: false` on the main window

`app` `security` `bug`

`src/electron/main.ts:63`. A sandboxed preload gets a polyfilled subset of the
electron module with no `sharedTexture`, and cannot `require` a relative file,
so the engine bridge cannot load under the default. `contextIsolation` stays on
and the `VideoFrame` never leaves the isolated world, so this is far weaker than
`nodeIntegration: true` — but it is still a real loosening of the app's posture.

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

### `probeVideoMetadata` reads the whole file into memory

`recorder` `perf`

On the fallback path only — pre-metadata recordings and crash recovery. Bounded
by how big a recording someone crashed out of, which is not a small bound.

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
