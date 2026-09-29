# Linux port

Goal: run recso, including the velocity engine, on Linux. The first target is Arch (Omarchy) on Hyprland/Wayland with an NVIDIA GPU. Work happens on `feat/linux-port`, branched from `feat/native-engine`.

## Licensing constraint

Copyleft software (ffmpeg, GStreamer, x264, fdk-aac, anything GPL/LGPL) is allowed as a **development tool only**: probing files, making fixtures, checking output in scripts and tests. Nothing copyleft may be linked into, bundled with, or required at runtime by the product. Product dependencies must be MIT/BSD/Apache/ISC/zlib. Note any MPL crate before adding it.

## Where things stand

velocity was written directly against Windows APIs. Linux needs a replacement for each one:

| Windows piece                                | Used for                    | Linux replacement (permissive)                                                   |
| -------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| Windows Graphics Capture (`windows-capture`) | screen and window recording | xdg-desktop-portal ScreenCast (`ashpd`, MIT) + PipeWire stream (`pipewire`, MIT) |
| GDI cursor APIs                              | cursor position and shape   | portal cursor metadata (`cursor_mode = metadata`)                                |
| Window enumeration + WGC thumbnails          | window picker               | portal picker on Wayland (it already shows windows)                              |
| WASAPI                                       | microphone and system audio | PipeWire capture of a source and of the default sink's monitor                   |
| nokhwa / Media Foundation                    | webcam                      | V4L2 (`v4l`, MIT)                                                                |
| Media Foundation decode                      | engine decode               | openh264 (BSD) first, VA-API later via `cros-codecs` (BSD)                       |
| D3D11 + HLSL                                 | compositing and effects     | `wgpu` (MIT/Apache) with the shaders ported to WGSL                              |
| Media Foundation encode                      | export, recording           | openh264 (BSD) first, VA-API encode later                                        |
| Media Foundation MP4 sink                    | muxing                      | pure-Rust MP4 muxer (e.g. `mp4`, MIT)                                            |
| AAC encoder                                  | audio track                 | Opus (`libopus`, BSD) in MP4                                                     |
| D3D11 shared NT handle into Electron         | preview frames              | dmabuf through Electron shared textures if available, otherwise CPU frame copies |

## Milestones

- [x] **M0: the JS side works on Linux.** `mise.toml` pins Node 24, because better-sqlite3 12.6 doesn't compile on Node 26. `pnpm install`, `pnpm typecheck`, `pnpm transpile:electron` and `pnpm test` (147 tests) all pass.
- [x] **M1: velocity compiles on Linux with the same JS API.** Windows crates move to `[target.'cfg(windows)'.dependencies]`. Every `#[napi]` export stays on Linux: unsupported ones return a clear "not supported on Linux yet" error (or an empty list, where a list is the natural answer), so `index.d.ts` doesn't change. Pure logic (cuts, zoom, pattern, clocks, PCM mixing, geometry) is compiled and tested on Linux too.
- [x] **M2: the Electron app launches on Linux.** `pnpm dev` opens, the recorder reports that native capture is unavailable instead of crashing, and `recorder-capture-plan.ts` knows about `linux`.
- [ ] **M3: capture on Linux.** Done: screen or window through the portal, system audio and microphone (PipeWire → Opus), cursor position (Hyprland), the webcam (V4L2), a streaming MP4 writer, and saving into a project that opens in the editor. Left: a person clicking the real portal picker once (every unattended test used `VELOCITY_TEST_PIPEWIRE_NODE`).
- [ ] **M4: engine on Linux.** Done: decode, probe, thumbnails, the wgpu composite chain (video, background, zoom, webcam, cursor) and the preview `VideoPlayer`. Left: export (`VideoExporter`).
- [ ] **M5: packaging.** `pnpm dist:linux` builds velocity for Linux (`build:engine:linux`), the renderer and an AppImage; the AppImage runs here with velocity loaded from `resources/velocity/`. The `.deb` target needs a maintainer email (see Log).

## M4 plan (engine on Linux)

In order of value, each usable on its own:

1. **Decode, probe, thumbnails** (done): `VideoDecoder`, `probeVideo`, `probeAudio`, `generateSpritesheet` in software. The `mp4` crate demuxes and openh264 decodes. The timeline gets its filmstrip, and a finished recording is validated by really decoding it. `sheet.rs` shares the slot-filling rules with Windows.
2. **`VideoPlayer`** (done; 33 methods, in `index.d.ts`). A decode thread and a clock (play/pause/rate/seek/tick) come first. Then the composition: a wgpu render chain porting `engine/shaders.hlsl` to WGSL, driven by the shared `layout.rs` / `scene.rs` / `zoom.rs` / `cuts.rs`, so placement stays identical to Windows. Frames reach the editor as DMA-BUFs through Electron's `sharedTexture` `nativePixmap` handle (planes with fd/stride/offset/size, plus a GBM modifier). The simplest correct route: render with wgpu, read back once, and write into a linear GBM buffer object (libgbm, MIT). `SharedTextureInfo` needs optional Linux fields (fd, stride, modifier), and `shared-texture.service.ts` needs a `nativePixmap` branch. `index.d.ts` is generated on Windows, so those fields must be added there by hand, or regenerated there.
   _Proven on this machine (2026-09-29):_ a linear `ARGB8888` GBM buffer object on the **Intel** render node (`/dev/dri/renderD129`, i915), filled from the CPU, exported as a DMA-BUF fd and passed to `sharedTexture.importSharedTexture` as a `nativePixmap` (`supportsZeroCopyWebGpuImport: false`, modifier `"0"`), arrives in the renderer as a BGRA `VideoFrame` with exactly the pixels written. On the NVIDIA node (`renderD128`), GBM rejects `LINEAR | RENDERING`, so allocate on the node Chromium composites with, which is the Intel one here. The frame plumbing (`SharedTextureInfo.dmabuf*`, `texture-handle.ts`) is already in.
3. **`VideoExporter`** (next): the same render chain with no presentation, frames into `capture/linux/encoder.rs`, audio mixed from the sources (Opus).

## Working on the port

- The project needs Node 24: `mise install`, then `mise exec -- pnpm ...`.
- Linux addon: `cd velocity && npx napi build --platform --release --no-js --dts target/index.linux.d.ts`. The `--no-js`/`--dts` flags keep the committed `index.js` and `index.d.ts` (generated on Windows, and the full API) from being overwritten with the partial Linux API.
- Rust tests: `cargo test --lib` in `velocity/`.
- After touching shared Rust code, type-check the Windows build: `velocity/scripts/check-windows.sh` (once: `rustup target add x86_64-pc-windows-msvc`).
- Platform code is split three ways. Pure logic (`engine/layout.rs`, `engine/scene.rs`, `engine/cuts.rs`, `engine/zoom.rs`, `capture/stopper.rs`, ...) builds and is tested everywhere. Windows backends stay `#[cfg(windows)]`. Other platforms get a backend module with the same functions (`capture/unsupported.rs`, `cursor_unsupported.rs`, `window_unsupported.rs` for now).

## M3 design (Linux capture)

- **Source selection:** the xdg-desktop-portal ScreenCast picker (`capture/linux/portal.rs`), shown when recording starts. Cursor mode `Hidden`, as on Windows (recso draws its own cursor). Not persisted: a remembered choice would never let the user switch sources, because the recorder has no picker of its own. The portal session lives on a thread that owns the D-Bus connection for the whole recording.
- **Frames:** `capture/linux/pipewire_stream.rs` negotiates packed 32-bit RGB in shared memory and hands frames to a callback on PipeWire's thread. `capture/linux/screen.rs` copies each frame into a 2-slot queue; frames are dropped there when the encoder falls behind, not held. Variable frame rate, like Windows: a still screen sends no frames.
- **Encoding:** `capture/linux/encoder.rs`: openh264 (BSD) → muxide (MIT/Apache) MP4. Audio is Opus (libopus, BSD), since there is no permissive AAC encoder.
- **Cursor:** Wayland gives apps no global cursor position, and the X11 hook (`uiohook-napi`) sees only XWayland windows. On Hyprland, `cursor_linux.rs` reads the position over Hyprland's IPC socket, and the mouse tracker polls it every 50 ms on Linux. **Known gaps:** no click events and no cursor shape on Linux yet. Clicks would need `/dev/input` access (the `input` group) or a compositor protocol.
- **Testing without a person at the picker:** a GStreamer `videotestsrc ! pipewiresink mode=provide` node (dev tool only) stands in for the portal's node.

## Log

Newest first. Record decisions and open questions for the user here.

- 2026-09-29: The editor previews through the Linux engine. `engine/linux/render.rs` ports the D3D11 chain to wgpu (WGSL shaders, the shared layout/scene/zoom geometry), and `engine/linux/player.rs` runs the Windows player's design: a decode thread, a bounded queue, the engine clock, exact seeks. Each frame is read back and copied into a linear GBM buffer whose DMA-BUF Electron imports. Checked in the app over CDP: a 1080p canvas plays at the recording's ~69 fps with no drops (about 7 ms per frame for decode, render and readback); background, padding, rounded corners, shadow and the camera overlay all show, and paused edits repaint at once. The audio mixer moved to the shared `engine/mix.rs` for the Linux exporter.
- **Decision for the user: the `.deb` maintainer.** electron-builder's deb target refuses to build without an author email (`author.email` in `package.json`, or `linux.maintainer` in `electron-builder.json`). I didn't add your email to the repo without asking. The AppImage builds and runs without it.
- **Note for the user: Electron's own ffmpeg.** Electron ships `libffmpeg.so` (`ffmpeg.dll` on Windows), Chromium's LGPL build, used for media playback. It comes with Electron itself, not from the port, and every Electron app ships it, but it is LGPL code in the product. Chromium can't play media without it.
- 2026-09-29: M4 step 1 and the webcam are done. The Linux engine decodes, probes and builds the timeline filmstrip; the editor shows thumbnails. Webcams record through V4L2 into the `_camera.mp4` sidecar, aligned to the screen's first frame. The AppImage from `pnpm dist:linux` runs here with the Linux addon inside.

- 2026-09-29: Recording works in the real app on this machine, driven over CDP with a PipeWire test node standing in for the portal. Record → stop → the file is finalised → a project in `~/Videos` → the editor opens (its preview says the GPU engine is unavailable, which is M4). Files carry H.264 plus Opus at matching durations, and the microphone picker lists the PipeWire sources. Fixed along the way: openh264 dropped about 60% of frames (rate control without timestamps); the stop waited two minutes for the engine's decoder (now it checks for the `moov` box); and moving the file out of `/tmp` failed across filesystems (EXDEV). **Please try one real recording:** the portal picker needs a click, which I couldn't do unattended.

- **Decision for the user: H.264 patents.** openh264 is BSD-licensed, but H.264 is patent-encumbered. Cisco pays the royalties only for its own prebuilt binary when users download it from Cisco. Development builds compile openh264 from source (the crate's `source` feature). For shipping, the usual approach (Firefox's) is the crate's `libloading` feature, which downloads Cisco's binary on first use. The alternative is VA-API/NVENC hardware encoding, where the GPU vendor covers the codec. Which one should the product use?

- 2026-09-29: M2 done. `pnpm dev` launches on Hyprland. The recorder offers a single "Screen or window (chosen when recording starts)" source on Linux instead of calling `desktopCapturer`, which on Wayland would open the portal picker just to fill the list. Pressing record shows velocity's "screen recording is not supported on linux yet". Checked by driving the running app over CDP (`--remote-debugging-port`). **Decision for the user:** `pnpm-workspace.yaml` has `allowBuilds: electron: false`, so a fresh `pnpm install` never downloads Electron's binary, on any OS. This checkout was fixed by running `node_modules/.pnpm/electron@40.0.0/node_modules/electron/install.js` once. Recommend setting `electron: true`.
- 2026-09-29: M1 done. velocity builds on Linux; 1187 Rust tests pass here (up from none), and the Windows build still type-checks. The capture, cursor and window API is identical on Linux and fails with "not supported on linux yet". The engine classes (`VideoPlayer`, `VideoExporter`, ...) are absent on Linux until M4, and Electron's `native.ts` already treats that as "engine unavailable".
- 2026-09-29: M0 done. Started M1.
