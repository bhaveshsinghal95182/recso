# GPU video engine

A second video path inside recso: hardware decode, grading and encode that
never take the pixels off the GPU. It lives in the `velocity` crate next to the
capture code and is exposed to the renderer as `window.electron.engine`.

Nothing in the editor uses it yet. That is deliberate — it went in as a
strangler fig, so the new path can take over one piece at a time instead of in
a single cutover.

## The two paths

```
today (editor)     recording.mp4 -> <video> -> Pixi CompositionEngine -> canvas
                                            \
                                             -> mediabunny + WebCodecs -> mp4

engine (parallel)  file -> MF hardware decode -> D3D11 texture
                        -> render chain (NV12->BGRA, effects)
                        -> shared NT handle -> Chromium -> canvas
                                            \
                                             -> NV12 -> hardware encoder -> mp4
```

Both end at a canvas, which is the whole reason a gradual swap is possible.
`FrameVideoSource` in `src/ui/screens/editor/engine/types.ts` is the seam:
`HtmlVideoFrameSource` wraps a `<video>`, and `GpuFrameSource` in
`gpu-frame-source.ts` wraps the canvas preload paints engine frames into. The
compositor — background, zoom, cursor, webcam, cuts — cannot tell them apart.

## Why the render chain sits before the fork

The effects run _before_ preview and export split, not after. A filter cannot
look one way on screen and another way in the file, because there is one
implementation and both consumers pull from it.

Filtering in the renderer instead — WebGPU over the imported `VideoFrame` — is
easier to iterate on, but then export needs a second implementation and the two
drift. For an editor that is a trap. recso's current path has this property too
(one `CompositionEngine`, used by preview and export), and the engine keeps it.

## Presentation, and why it goes through preload

A `VideoFrame` cannot cross a contextBridge. The prototype this came from
solved that by running with `nodeIntegration: true` and
`contextIsolation: false`, which is not a trade worth making here.

So the frame never leaves the isolated world:

```
main process              preload (isolated)           main world
tick() ------------> receiver -> drawImage -> [ canvas ] -> Pixi / 2D
```

`preload-engine.cts` registers the shared-texture receiver at load time and
paints into a canvas that lives in the page. The main world only touches that
canvas. The pixels stay on the GPU until the `drawImage`, and even then only as
far as the compositor.

This is why the main window now sets **`sandbox: false`**. A sandboxed preload
gets only a polyfilled subset of the electron module -- `ipcRenderer`,
`contextBridge`, `webFrame` -- with no `sharedTexture`, and it cannot `require`
a relative file either, so the bridge cannot load at all. Note this is still
far weaker than what the prototype needed: `contextIsolation` stays **on**, so
the main world has no Node and sees only what the contextBridge exposes.

The bridge is loaded inside a `try`/`catch` and degrades to a stub that reports
`available: false`. It is an optional path, and an exception escaping it would
take the whole `window.electron` bridge down with it -- breaking recording and
editing along with the preview.

**Renderer `console.*` does not reach the log file.** Preload patches the
console of the _isolated_ world, so main-world logs go nowhere the main process
can see. Anything in the renderer that needs to end up in the log has to go
through `window.electron.logging`. The autorun check does exactly that; using
`console.log` there made a working check look like one that never ran.

The receiver must be registered before the main process sends anything —
`sendSharedTexture` throws after 1000ms if nothing is listening — which is why
it installs at preload time and never unregisters. Binding a canvas later is
fine; frames arriving before then are consumed and released, just not drawn.

There is **one sink at a time**. The harness binds its own visible canvas; the
editor seam binds a hidden one. They cannot both be live.

## Both processes have to be on the same GPU

A shared texture handle is only meaningful to the adapter that created it. If
the engine and Chromium disagree, the preview goes black or garbled while every
layer reports success — which is close to impossible to read backwards from the
symptom.

The engine asks `IDXGIFactory6::EnumAdapterByGpuPreference` for the
high-performance adapter, and `main.ts` passes `force_high_performance_gpu` so
Chromium follows. `checkGpuMatch()` compares the two at startup and logs both.

`EnumAdapterByGpuPreference` does not return a fixed answer. **On battery,
Windows reports the integrated GPU as the high-performance one**, so both
processes move to the Intel together. That is fine — they agree, which is what
matters. It does mean the same build produces very different numbers on AC and
on battery, so check the logged adapter before trusting any measurement.

| `RECSO_ENGINE_GPU` | effect                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unset / `auto`     | follows the power policy. Both processes agree. Safe everywhere.                                                                                                                                            |
| `integrated`       | forces the default adapter for both, and skips the Chromium switch.                                                                                                                                         |
| `force-discrete`   | most dedicated memory regardless of policy. **Breaks the preview on battery** — the engine moves to the NVIDIA and Chromium stays on the Intel. Export is unaffected, since it never goes through Chromium. |

## The recording path

recso records H.264 now -- both tracks. `desktop_capture.rs` and
`webcam_capture.rs` each set `VideoSettingsSubType::H264`; the camera sidecar
was missed by the first pass and stayed on windows-capture's HEVC default, so
the screen track opened in the engine and the camera next to it failed with
`0xC00D5212 "No suitable transform was found"`. windows-capture's default is HEVC, and on a
stock Windows install there is no HEVC decoder MFT for Media Foundation to
enumerate -- the GPU can decode it, but the MFT that would let us comes from
the paid Store "HEVC Video Extensions". H.264 is the only subtype with a
hardware decode profile, a decoder present everywhere, and MP4 sink support,
which is what keeps the pipeline GPU-resident.

### No yellow border

`DrawBorderSettings::WithoutBorder` is not enough on its own. windows-capture
turns it into `GraphicsCaptureSession::SetIsBorderRequired(false)`, and Windows
ignores that unless the process has borderless capture access -- the call
succeeds, the flag reads back as set, and the border is still drawn. Which is
why it looks like the setting is broken rather than incomplete.

`capture/borderless.rs` asks for it once per process via
`GraphicsCaptureAccess::RequestAccessAsync(Borderless)`. It is a capability
check, not a user prompt, so nothing appears on screen. Grant depends on
Windows version and packaging, so the result is logged rather than assumed:

```bash
node -e "console.log(require('./velocity').borderlessCaptureAllowed())"
```

A denial costs a border, not a recording.

### The recorder describes what it wrote

`Stopper.stop()` returns a `RecordingMediaInfo` per capture. The encoder
configures the geometry, codec and bitrate, and the capture handler sees every
frame timestamp and every audio byte, so all of it is known at capture time.
It used to be reconstructed afterwards by demuxing the finished file with
mediabunny -- which was slower, read the whole file into memory, and in one
case could not answer at all.

| field              | was                                     | now                                    |
| ------------------ | --------------------------------------- | -------------------------------------- |
| `width` / `height` | demux                                   | first frame the encoder was built from |
| `durationMs`       | `computeDuration()` over the whole file | wall clock, first frame to stop        |
| `fps`              | **hardcoded to 30**                     | frames over elapsed time               |
| `frames`           | unavailable                             | counted                                |
| `hasAudio`         | demux, checking sample counts           | captured audio bytes > 0               |
| `codec`, `bitrate` | —                                       | what the encoder was configured with   |
| `usable`           | —                                       | did any frame arrive                   |

Two of those are worth dwelling on.

**fps was never recoverable.** Screen capture is variable-rate: Windows only
delivers a frame when something changes. The container carries a nominal 60,
the editor assumed 30, and a measured capture of an idle desktop runs at 1.7.
All three are different numbers and only the last is real. Treat it as an
average, not a cadence -- for anything frame-exact use `frames` with
`durationMs`.

**`hasAudio` could not be answered by track presence.** windows-capture always
registers an audio stream, so every video-only recording carries an AAC track
with zero samples. Distinguishing that stub from real audio needed a demux
pass; now it is just whether any captured byte reached the encoder. The
zero-padding used to keep the audio buffer aligned to the frame cadence
deliberately does not count.

The info is persisted with the recording (`recordings.media_info`, added by an
idempotent `ALTER TABLE` since the schema has no migration framework), so it
survives a reload and the editor never probes. Recordings made before this, and
files recovered after a crash, have no stored info and fall back to the old
mediabunny probe.

### Opening a recording in the engine

```ts
const opened = await window.electron.engine.player.openRecording(recordingId);
```

Looks up the stored metadata and opens the file with it -- no probe anywhere in
the path. The result reconciles both sources rather than silently picking one:

- **geometry** from the container, since that is what the decoder hands back
- **duration** from the container, since that is what seeking is bounded by;
  the recorder's wall-clock figure comes back as `captureDuration` alongside it
- **fps, frames, hasAudio, codec** from the recorder
- **`disagreements`** listing anything that did not line up

Those two durations do not converge, and the check is deliberately loose about
it. The recorder times first-frame-to-stop; the container runs sample zero to
the end of the last sample. Each end carries slop the other cannot see --
capture startup latency, the encoder's timeline base, the tail sample. Measured
across runs the gap ran +658ms to -518ms with no relationship to frame rate
(-402ms at 12fps, where a frame is 81ms). The tolerance is there to catch a
recording paired with the wrong file, not to police a few hundred ms.

## Layers: desktop, webcam, cursor

The engine composites three layers, and does it _inside_ the render chain --
after the effect pass, before the preview/export fork. Same reason the grading
sits there: one implementation, so the webcam cannot be in a different place on
screen than it is in the exported file.

```
desktop NV12 -> BGRA -> [effects] -> dst
webcam  NV12 -> BGRA -----------------^  quad, shape-masked
cursor  RGBA ------------------------- ^  quad, alpha from the image
```

The overlays are quads rather than fullscreen passes, so they need their own
vertex shader, a blend state and a shape mask -- `composite.rs` and the
`vs_quad` / `ps_overlay` / `ps_sprite` half of `shaders.hlsl`. The mask is a
signed distance field evaluated in _pixels_, not UV, so corners stay circular
whatever the box's aspect ratio.

### One clock, two decoders

The camera is a second decoder on the same thread, not a second player. Two
players would each own a clock and the two would drift; here the camera is
pulled to whatever timestamp the screen frame has.

They do not line up on their own. The camera runs at a fixed rate while screen
capture only produces a frame when something changes, so the ratio is not even
constant -- on an idle desktop the screen can be at 1.7fps against a camera at 30. `advance_webcam` inherits the previous slot's camera image first, so a
screen frame with no new camera frame keeps showing the last one, then advances
the decoder while it is behind.

The frame that overshoots the target is staged rather than dropped. It costs at
most one camera interval of lead -- ~33ms, invisible on an overlay -- and the
alternative is discarding camera frames every time the screen ticks faster than
the camera.

A seek clears every staged camera frame and seeks the camera too. Holding a
stale one over the new position is worse than showing nothing, because it looks
correct.

### The cursor holds, it does not interpolate

`setCursorTrack` takes positions normalised 0..1 against the source video, so
they survive it being scaled into a different canvas. The sample in effect at a
timestamp is the last one at or before it, held until the next: the pointer does
not move between reports, and smoothing would invent motion that never happened.

The position is resolved when a frame is _staged_, not when it is rendered, and
remembered against the slot. That matters because re-rendering is routine here
-- a grading change, a webcam move -- and the frame has to get the pointer back
where _it_ had it, not where the playhead has since moved to.

`hotspotX`/`hotspotY` say where the pointer's tip is inside the bitmap. Without
them an arrow lands below and right of the place that was clicked.

Anything that changes how a staged frame looks -- effects, webcam layout, cursor
image, track or style -- re-renders the frames already queued rather than going
back to the decoder, and re-resolves each slot's cursor rect while doing it.
Skipping that second half was a real bug: hiding the cursor left every frame
already in flight still showing it.

### Placement lives on the JS side

`setWebcamLayout` takes a rectangle in the screen recording's own pixels. The
anchor grid, size ratios and margins are resolved by the caller and arrive here
already flattened, so the app has one placement formula rather than two that
have to agree. A zero-width or zero-height box is the off switch and costs
nothing to render.

## Building and checking

The Rust is not built automatically — a release build is about two minutes, and
most work in recso never touches it.

```bash
pnpm build:engine
```

Headless check of everything except presentation (decode, exact seek, the
clock, grading, export):

```bash
pnpm engine:check path/to/h264.mp4 --export out.mp4
```

Record, describe, and open in the engine with no demux pass anywhere -- this
records a few seconds of the primary monitor:

```bash
node velocity/scripts/pipeline-check.mjs 5
```

Desktop, webcam and cursor composited together, verified by reading the
finished frame back -- this records a few seconds of screen _and_ camera:

```bash
pnpm engine:composition
```

Colour readback is the only way to tell a composited frame from one that
silently drew nothing, which is exactly the failure this catches.

Presentation needs a live Chromium GPU process, so it is checked from the
harness instead. This plays for three seconds and then reads the canvas back —
the only way to tell a working preview from a silently black one:

```bash
VITE_ENGINE_AUTORUN=path/to/h264.mp4 pnpm dev
```

Or drive it by hand: `pnpm dev`, then load the app at `#engine`. Dev builds
only; a production bundle has no route to the harness.

## Measured

1080p H.264 (Big Buck Bunny, 30fps), RTX 4050 on AC, machine otherwise idle.

```
decode                1.61 ms/frame
exact seek            median 170 ms   (102 frames decoded forward)
playback              0 dropped, queue 12 deep, media tracks wall clock exactly
tick() queue wait     0 us worst
40 effect changes     0 re-decodes, max 0.03 ms
export, steady        287.6 fps       decode 0.19 + render 0.81 + encode 0.92
export setup          681 ms
```

Presentation, measured through the harness autorun in the real app (3 seconds
of playback, then a canvas readback):

```
pool warm-up          19.9 ms         (BGRA; it was 382 ms when the pool was NV12)
painted               85 frames
frame                 BGRA 1920x1080, display 1920x1080
canvas                100% non-black, 64 distinct colours, centre [57,48,3]
silent frame loss     0 no-texture, 0 render-error
dropped               4 of 101 decoded
```

The canvas readback is the point of that check: a black canvas and a working
preview look identical from every other vantage point. The 4 dropped frames are
startup overhead under the Vite dev server with HMR attached; the headless
script on the same clip drops none.

Setup is reported separately from steady-state fps because it varies a lot
(roughly 480–1900ms, worst when the discrete GPU is waking from idle), and on a
short clip it dominates enough to make the faster GPU look slower.

## Why grading is cheap

Each pool slot keeps the decoded NV12 it was rendered from, not just the
finished BGRA. A colour change re-runs two shader passes over pixels already on
the GPU instead of going back to the decoder.

The obvious implementation re-seeks to the current position on every change,
which on long-GOP content is 300–600ms of decoding _per slider event_. Paused,
only the frame on screen is re-rendered; playing, every queued slot is
re-rendered in place. A drag emits a change per pixel of travel, so the decode
thread drains its command channel and keeps only the last of each kind.

## What is not there

- **No audio.** The clock is video-only. Audio has to become the master clock
  eventually, and `Clock` is what will have to slave to it.
- **No timeline, no clips.** recso's cut and zoom model still lives entirely in
  the Pixi compositor and has no counterpart here. The webcam and cursor layers
  do now exist in the engine; backgrounds, zoom regions, click effects, cursor
  motion blur and per-region cursor overrides do not.
- **The camera sidecar is not described by `stop()`.** Only the screen track
  reports a `RecordingMediaInfo`, so the camera's dimensions and aspect ratio
  still have to come from opening it.
- **One hardcoded effect** (brightness/contrast/saturation). The ping-pong
  targets exist but nothing drives a chain of arbitrary passes.
- **The cache is only as deep as the pool.** 18 slots, so scrubbing back a
  second still costs a seek.
- **Presentation is a round trip per frame.** ~3ms, fine at 30fps, will not
  scale to 4K120.
- **BT.709 studio swing assumed.** No BT.601, no full range, no HDR.
- **Windows and D3D11 only.** Everything under `velocity/src/engine/` is
  `#[cfg(windows)]`, and the crate still builds without it elsewhere.
- **H.264 only.** Recordings made before the switch to H.264 are HEVC and will
  not open in the engine on a machine without the Store HEVC extension. They
  still work in the editor's `<video>` path, which goes through Chromium.

## Adding a filter

1. Write the pixel shader in `velocity/src/engine/shaders.hlsl`. It samples
   `Source` (BGRA) and returns BGRA. Add parameters to the `Params` cbuffer,
   keeping it a multiple of 16 bytes.
2. Compile it in `RenderChain::new` and store the `ID3D11PixelShader`.
3. Run it in `render_locked`, between the conversion pass and the destination.
   More than one effect means ping-ponging between `intermediate` and a second
   target rather than writing straight to `dst_rtv`.
4. Extend `EffectParams` **and `is_identity`**, so an unused filter still costs
   nothing. This is the step people skip, and without it every frame pays for a
   pass that does nothing.
5. Surface it: `VideoPlayer::set_effects`, the `engine:player:effects` handler,
   `ExportOptions`, `EngineAPI`, and a control in the harness.

## Adding a native function

1. Write it in `velocity/src/engine/api.rs` with `#[napi]`.
2. `pnpm build:engine` — regenerates `velocity/index.js` and `index.d.ts`.
3. Add it to `EngineBindings` in `src/electron/types/engine.types.ts`.
4. Wrap it in a service, register an `ipcMain.handle` in `ipc/engine.ipc.ts`.
5. Expose it in `preload-engine.cts` and type it in `src/ui/electron.d.ts`.

Step 3 is a hand-maintained mirror of the generated `index.d.ts`, so the main
process does not depend on a file that only exists after a Rust build.
