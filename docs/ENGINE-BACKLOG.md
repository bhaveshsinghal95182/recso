# GPU engine: bugs, gaps and missing features

Everything known to be wrong with or missing from the engine, as of the
`feat/native-engine` branch. [ENGINE.md](ENGINE.md) explains how the thing
works and why; this is the list of what it does not do yet.

Two kinds of entry, kept apart on purpose:

- **Bugs** — the code is wrong. Something claims to work and does not, or works
  differently from how it is documented.
- **Gaps** — the code is honest, there is just less of it than there needs to
  be. No promise is being broken.

**Confirmed** means it was observed. **Latent** means it is wrong by reading but
has not bitten on the files tested so far — worth knowing before someone spends
an afternoon on the symptom. **Fixed** entries stay on the list with what was
done, because the reasoning is worth keeping and a strikethrough throws it away.

---

## Bugs

### 1. Export drops the webcam and cursor — _fixed_

The whole argument for compositing inside the render chain is that preview and
export cannot drift. That holds for grading. It does not currently hold for the
overlay layers.

`run_export` builds its own chain at
[`exporter.rs:214`](../velocity/src/engine/exporter.rs#L214) and never calls
`attach_webcam`, `set_cursor_image`, `set_cursor_track` or `stage_cursor`. Only
`Player` populates those. So an export gets desktop plus grading, and the camera
and pointer silently vanish from the file. `ExportOptions` has no fields to pass
them either.

Worth being blunt about: this makes the engine's headline property false for
two of its three layers, and the preview looks completely correct while it
happens.

**Fixed.** `ExportOptions` now carries `webcamPath`, `webcam`, `cursor`,
`cursorTrack`, `cursorSize` and `cursorOpacity`. `run_export` opens its own
camera decoder (tolerating one that will not open, as the player does), attaches
the layer, uploads the sprite, and per frame calls `advance_webcam` and
`stage_cursor` with the frame's own pts. A `start` offset now seeks both
decoders rather than only the screen, or the overlay would begin the export
showing whatever the camera was doing at t=0 and catch up over the next few
seconds. The chain itself needed no changes — it already composited whatever it
was given.

`advance_webcam` and `WebcamSync` became `pub(crate)` and are shared with the
player rather than reimplemented: a second copy is a second thing to drift.

Verified by `pnpm engine:export-composition`, which exports the same recording
twice — once bare, once with the overlays — and compares pixels between the two
files. That shape is deliberate. A preview-side check cannot catch this class of
bug, because the failure _is_ the two paths disagreeing.

### 2. Grading does not apply to the overlays — _superseded: grading goes per-layer_

[`render_locked`](../velocity/src/engine/render.rs#L633) runs base → effects →
destination, and only then draws the webcam and the cursor. So desaturating a
recording leaves the camera in full colour and the pointer untouched.

Documented as deliberate, and defensible if you read the overlays as UI drawn on
top of a graded picture. For an editor it is probably the wrong default — a
grade the user reads as "the look of this video" stops at the edge of the webcam
box.

**Superseded.** The question this entry asks — does the grade sit above or below
the overlays — only exists because there is one global grade. Make grading
per-layer and it stops being a question: each layer carries its own
`EffectParams` and there is no ordering to get wrong.

That is also the better model for what these layers actually are. The screen
recording and the camera are two different sensors with two different exposures.
A face that is underexposed has nothing to do with a screen that is too bright,
and one global grade cannot fix both — it can only trade one against the other.

**Shape.** `EffectParams` becomes per-layer rather than a single field on
`RenderChain`. The webcam's copy rides in the overlay constant buffer, which is
already uploaded per draw, and `ps_overlay` applies it where it currently just
samples and computes alpha. That costs no extra pass and no extra texture — the
alternative, running `ps_effect` over the webcam's BGRA scratch, needs a second
target at camera resolution for no benefit.

The cursor keeps identity params. It is a PNG of a pointer; there is nothing
there to grade.

**The cost is the API, not the rendering.** `setEffects(brightness, contrast,
saturation)` has to become per-layer, and `ExportOptions` with it — a breaking
change to the napi surface, the preload and the Electron type mirror. Which is
the argument for doing it now: per the integration section below, every one of
these setters is wired end to end and called by nothing, so there is no
migration to do. This is the cheapest this change will ever be.

Sequenced after the feature map, since the same question applies to the other
per-layer properties the engine does not have yet (webcam borders and shadows,
the video layer's own border and radius) and the API should be shaped for all of
them at once rather than growing a second parameter per feature.

### 3. Cursor position is scaled by coded size, not display size — _fixed_

The chain is constructed with the decoder's _coded_ dimensions, and
[`resolve_cursor_rect`](../velocity/src/engine/render.rs#L476) multiplies the
track's normalised positions by `self.width` / `self.height`. Normalised
positions are relative to the _visible_ frame.

H.264 pads to macroblock alignment, so a nominally 1080-tall video is often
coded at 1088. On such a file the pointer drifts by ~0.7% vertically — about 8px
at the bottom of the frame, none at the top, which reads as "the cursor is
slightly off and getting worse further down" rather than as a scaling bug.

Latent because every file tested here comes back coded == display: both test
clips and every recording velocity produces. The composition check passes with
the pointer landing on the exact pixel, which is why this needs finding by
reading rather than by testing.

**Fixed**, and it went deeper than the cursor. `Decoder.display_width` was never
the display width: it was `MF_MT_FRAME_SIZE`, which on a padded file _is_ the
coded size. Both names existed, both held the same number, and the aperture was
never read at all.

`Decoder` now reads `MF_MT_MINIMUM_DISPLAY_APERTURE` — the _minimum_ aperture
specifically, since pan-scan and the geometric aperture are editorial crops and
would throw away picture the user recorded — and exposes `display_size` beside
`coded_size`. `RenderChain::new` takes both. Textures stay coded-sized;
normalised cursor positions resolve against the display size.

Two consequences beyond the cursor. `SharedTextureInfo.visibleWidth/Height` now
reports the real visible size rather than repeating the coded one, which is what
Electron wanted from it in the first place. And the NV12 output passes read only
the display sub-rectangle, so an export is the visible size instead of carrying
eight rows of decoder scratch — the exporter's encoder is sized from
`chain.output_size()` now, not from the decoder.

Still untested against an actually-padded file, because nothing on hand produces
one. Both composition checks cover the identity case, and `RenderChain::new`
falls back to the coded size on a missing or nonsensical aperture.

### 4. The webcam is stretched to its box, not fitted — _fixed_

The overlay quad maps the full camera texture across whatever rect it is given.
Hand it a 16:9 box for a 4:3 camera and the picture distorts; nothing letterboxes
or refuses.

Placement lives on the JS side by design, so arguably the caller's problem. But
the engine will do the wrong thing silently rather than making it visible, and
the editor's Pixi path computes the box _from_ the camera's aspect ratio, so the
two will disagree the moment anyone drives the engine from a resize handle.

**Fixed**, and the engine owns it. `WebcamLayout` gained a `FitMode`:

- `cover`, the new default, crops the source to the box's aspect ratio through
  the quad's UVs. The box is honoured exactly and nothing distorts.
- `contain` shrinks the box to the camera's shape and recentres it inside the
  rect that was asked for.
- `stretch` is the old behaviour, now something a caller has to ask for by name.

Cover is the default because it is the only mode that cannot look visibly
wrong — no distortion, no gap — and it is the only sane choice inside a circular
box.

The engine owns it rather than the caller because the engine is the only side
that knows the camera's real resolution. Working it out in JS means opening the
sidecar, which is exactly the demux the recorder metadata work exists to avoid —
so this no longer pairs with the recorder describing the sidecar, the way the
original note assumed it would.

Cover crops through UVs rather than by growing the quad because the shape mask
is evaluated against the quad: grow it and a circular webcam gets clipped by the
box instead of filling it.

### 5. Webcam overlay can lead by up to one camera frame — _known, deliberate_

[`advance_webcam`](../velocity/src/engine/player.rs#L636) stages the camera frame
that overshoots the target rather than dropping it, so the overlay can be up to
one camera interval ahead of the screen — ~33ms at 30fps.

Deliberate. The alternative is discarding camera frames whenever the screen
ticks faster than the camera, which on a busy screen is most of them. Invisible
on an overlay, and listed only so nobody rediscovers it as a mystery.

Becomes wrong if the webcam is ever composited full-frame, or if lip sync starts
mattering — i.e. when audio arrives.

### 6. Overlay opacity is not clamped — _fixed_

[`api.rs:758`](../velocity/src/engine/api.rs#L758) passes
`opacity.unwrap_or(1.0)` straight through to the shader. A value above 1
multiplies into alpha and over-brightens the edge rather than being rejected or
saturated. Cursor opacity _is_ clamped in `set_cursor_style`; the webcam's is
not.

**Fixed**, though not quite as one `.clamp`. It lives in
`WebcamLayout::sanitized`, called from `RenderChain::set_webcam_layout`, so every
caller gets it — the exporter included — rather than at the napi boundary where
the next caller would have to remember. It also floors a negative corner radius,
which folds the rounded-rect distance function inside out, and flattens a
non-finite rect to nothing, because a `NaN` width sails straight past
`is_empty` and into `to_ndc`.

### 7. Recordings made before the H.264 switch have an undecodable camera track

Not fixable, listed so the symptom is recognisable. The camera sidecar was HEVC
until [`69bc00a`](#). The screen track opens and the camera beside it fails with
`0xC00D5212` — no HEVC decoder MFT on a stock Windows install, even though the
GPU itself can decode it.

Those recordings still play in the editor's `<video>` path, which goes through
Chromium.

### 8. `sandbox: false` on the main window

[`main.ts:63`](../src/electron/main.ts#L63). A sandboxed preload gets only a
polyfilled subset of the electron module, with no `sharedTexture`, and cannot
`require` a relative file — so the engine bridge cannot load at all under the
default.

`contextIsolation` stays on and the `VideoFrame` never leaves the isolated
world, so this is much weaker than the prototype's `nodeIntegration: true`. It
is still a real loosening of recso's posture, taken for a path nothing uses yet,
and it should be revisited if the engine is ever abandoned.

---

## Missing: parity with the Pixi compositor

What the editor's `CompositionEngine` does that the engine does not. The engine
has the three layers; it does not have most of what the editor draws on them.

| Feature                            | Engine | Notes                                                                                              |
| ---------------------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| Screen video                       | yes    |                                                                                                    |
| Webcam overlay                     | yes    | shape, corner radius, and aspect fit                                                               |
| Cursor sprite                      | yes    | one global bitmap; see below                                                                       |
| Brightness / contrast / saturation | yes    | one hardcoded pass                                                                                 |
| Backgrounds                        | **no** | colour, pattern, image                                                                             |
| Zoom regions                       | **no** | the animated zoom/pan timeline                                                                     |
| Cuts / trim                        | **no** | no timeline model at all                                                                           |
| Click effects                      | **no** | click animations and indicators                                                                    |
| Cursor smear                       | **no** | stretch along the direction of travel; not the compositor's blur trail                             |
| Per-region cursor overrides        | **no** | recso's track carries a `cursorDataUrl` _per event_; the engine has one bitmap for the whole track |
| I-beam detection                   | **no** | the known-handle special case                                                                      |
| Webcam borders and shadows         | **no** | shape and radius exist; borders and shadows do not                                                 |
| Canvas padding / layout            | **no** | the video's placement within a larger canvas                                                       |

The per-region cursor override is the structural one. The engine's cursor is a
single `SpriteTexture` plus a track of positions; recso's model allows the
bitmap to change per sample. Supporting that means an atlas or a small texture
cache keyed by image, not just another field.

---

## Missing: engine-wide

- **No audio in playback.** Export has it now — decode, mix, cut-aware
  placement and an AAC stream, verified by `pnpm engine:audio`. Playback does
  not, and that is the harder half: audio has to become the master clock, and
  `Clock` currently free-runs on the wall clock with the picture following it.
  Inverting that is a rework of the thing the whole player is built around.
- **No timeline or clip model.** One source plus one overlay. Cuts, ordering and
  multiple clips have no representation.
- **One hardcoded effect.** The ping-pong targets exist but nothing drives a
  chain of arbitrary passes.
- **Frame cache is pool-depth only.** 18 slots, so scrubbing backwards a second
  still costs a seek.
- **Exact seek costs 170–280ms**, because GOP length is not controllable.
  `windows-capture`'s `VideoSettingsBuilder` exposes only subtype, bitrate,
  dimensions, frame rate, pixel aspect ratio and a disable flag, and it builds a
  WinRT `VideoEncodingProperties` rather than going through CODECAPI — so there
  is nowhere to set `CODECAPI_AVEncMPVGOPSize`. Needs an upstream PR or a
  SinkWriter that bypasses the crate for the video leg.

  Worth stressing: every per-frame cost in the engine is already sub-millisecond.
  Seek is the only number left that is big, and GOP length is the whole of it.

- **Presentation is an IPC round trip per frame** (~3ms). Fine at 30fps, will
  not scale to 4K120.
- **BT.709 studio swing assumed.** No BT.601, no full range, no HDR. Real files
  carry this in metadata and the engine ignores it.
- **Windows and D3D11 only.** Everything under `velocity/src/engine/` is
  `#[cfg(windows)]`; the crate still builds elsewhere without it.

---

## Missing: recorder

- **`stop()` does not describe the camera sidecar.** Only the screen track
  returns a `RecordingMediaInfo`, so the camera's dimensions and aspect ratio
  still have to come from opening the file — which is exactly what the metadata
  work existed to avoid. No longer blocking anything: bug 4 was fixed by having
  the engine fit the camera itself, since it already knows the resolution the
  caller would have had to demux for. Still worth doing for anything on the JS
  side that wants the aspect ratio before the engine is involved.
- **`probeVideoMetadata` still reads the whole file into memory** on the fallback
  path, used for pre-metadata recordings and crash recovery.
- **Audio is written to sidecars, not interleaved.** The recorder writes system
  audio and the microphone beside the recording rather than muxing them in.
  Interleaving is the goal; keeping the sidecar as an option is worth having for
  callers that do not want the audio at all. (Was item 1 of `todo.md`.)
- **`stop()` does not report file size or frames dropped.** Geometry, duration
  and frame count are described at capture time; these two are not, and dropped
  frames in particular are only visible in the recorder's own logs. (Was item 2
  of `todo.md`.)
- **`hasReadableVideoTrack` is still a mediabunny probe** in the finalize poll.
  Deliberate: it checks the file is muxed and readable on disk, which a frame
  count cannot tell you.

---

## Missing: integration

Nothing in the app drives any of this. Everything below is wired end to end and
called by nothing.

- `GpuFrameSource` implements `FrameVideoSource` — the seam the compositor would
  pull from — and no editor code constructs it.
- `engine:player:open-recording` takes a recording id, reads the stored metadata
  and opens with no probe. Nothing calls it.
- The webcam and cursor setters are exposed through IPC and preload. No UI drives
  them.
- **Only one frame sink can be bound at a time.** The dev harness binds its own
  canvas, so the harness and an editor preview cannot both be live. This will
  matter the moment the editor starts using the engine.
- **Two export paths coexist** — the engine's and mediabunny's — with nothing
  choosing between them.
- Prototype leftovers still in the napi surface: `Pipeline`, `TestPatternSource`,
  `PatternEncoder`.

---

## Suggested order

Bugs 1, 3, 4 and 6 are done. What is left, in order:

1. **The feature map.** [ENGINE-FEATURE-MAP.md](ENGINE-FEATURE-MAP.md) — what the
   editor's compositor and its mediabunny export actually do, against what the
   engine has. Everything below depends on knowing the shape of the target.
2. **Per-layer grading** (bug 2, above). Shaped together with the other
   per-layer properties the map turns up, so the napi surface changes once
   rather than once per feature.
3. **Integration.** Everything in this engine is wired end to end and called by
   nothing. The map ends with a proposed order.
4. **GOP length.** The only remaining large number in the system.
5. **Audio in playback**, and the clock inversion it forces. Export already has
   sound.
