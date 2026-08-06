# velocity

Native Windows screen, window, cursor and webcam capture for `recso`, built with
[napi-rs](https://napi.rs). Exposes a Node addon (`index.js` + a platform `.node`
binary) that the Electron main process loads by path — see `electron-builder.json`,
which bundles `velocity/index.js` and `velocity/*.node` into the packaged app.

The Rust side lives in [src/](./src):

| Module                                                           | Responsibility                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`capture/desktop_capture.rs`](./src/capture/desktop_capture.rs) | Monitor & window recording via Windows Graphics Capture, plus WASAPI loopback audio |
| [`capture/webcam_capture.rs`](./src/capture/webcam_capture.rs)   | Webcam enumeration and the `_camera.mp4` sidecar recording                          |
| [`cursor.rs`](./src/cursor.rs)                                   | Cursor position/shape snapshots and timed sampling, serialized as JSON              |
| [`window.rs`](./src/window.rs)                                   | Capturable-window enumeration with JPEG thumbnails                                  |
| [`singular_clock.rs`](./src/singular_clock.rs)                   | Pure timing/geometry helpers shared by the capture paths                            |

## Build

```bash
pnpm build          # release build
pnpm build:debug    # debug build
```

This produces `velocity.win32-x64-msvc.node` in the package root, loaded by
[index.js](./index.js). Rebuild after any Rust change — the JS tests and CLI run
against the compiled binary, not the source.

## Testing

There are four layers, cheapest first. The first two need no hardware and no build;
the last two drive real capture on the current machine.

| Layer               | Command               | What it covers                                                                                                                                                 | Needs a build?          |
| ------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Rust unit tests     | `pnpm test:rust`      | Pure logic: clock/tick math, overlay & crop geometry, audio byte pacing, sidecar path derivation, RGB→BGRA conversion, fps clamping, `Stopper` channel fan-out | No (`cargo test --lib`) |
| ava suite           | `pnpm test`           | API surface, enumeration shape, cursor JSON contract & clamping                                                                                                | Yes                     |
| ava recording tests | `pnpm test:recording` | Real capture end-to-end (opt-in, see below)                                                                                                                    | Yes                     |
| Smoke test          | `pnpm smoke`          | Real capture end-to-end with pass/fail summary and a non-zero exit code                                                                                        | Yes                     |

### Rust unit tests

```bash
pnpm test:rust
```

These are the only tests that run anywhere, including CI without a display or camera.
Everything testable as a pure function lives here — if you're adding logic to the
capture path, prefer extracting it into a free function so it can be covered here
rather than only through a real recording.

### ava suite

```bash
pnpm test
```

Recording tests are **skipped by default** so this stays fast and side-effect-free —
the recording specs write real video files and window recording steals foreground
focus. Opt in with:

```bash
pnpm test:recording
```

(That sets `VELOCITY_RUN_RECORDING_TESTS=1`; see `__test__/helpers/env.ts`.)

### Smoke test

The fastest way to answer "does capture still work on this machine?" after a Rust
change. Runs in ~7s, prints a PASS/FAIL/SKIP table, and exits non-zero on failure so
it can gate CI.

```bash
pnpm smoke              # core checks + monitor recording
pnpm smoke --webcam     # also exercise the webcam sidecar (needs a camera)
pnpm smoke --window     # also record a real window (steals focus)
pnpm smoke --no-audio   # skip the system-audio check
pnpm smoke --json       # machine-readable results
pnpm smoke --keep       # keep the recordings it produces for inspection
```

### CLI

`cli/velocity-cli.mjs` is the manual-testing surface: every native API is reachable
from it without writing a script, and every command takes `--json` so it can also be
driven from one.

```bash
pnpm cli help
pnpm cli check                # environment diagnostics
pnpm cli list-windows --json
pnpm cli list-webcams
pnpm cli cursor snapshot
pnpm cli cursor samples --duration 3000 --out samples.json
pnpm cli record monitor --duration 4000 --audio --output out.mp4
pnpm cli record monitor --webcam --cursor --fps 30
pnpm cli record window --title "Visual Studio Code" --duration 5000
pnpm cli interactive          # prompt-driven picker
```

`record` accepts `--assert-non-empty`, which exits 1 if the output file ends up
missing or empty — useful for scripting a capture check without the full smoke test.

## Known issues

**System audio recording is broken.** Passing `includeSystemAudio: true` (or `--audio`
from the CLI) produces an 80-byte header-only mp4, and `Stopper.stop()` blocks for its
full 8s timeout because the capture thread never signals completion. This reproduces on
both `startMonitorRecording` (v1) and `startMonitorRecordingV2`, at both 30 and 60 fps,
so it is in the shared audio path in `src/capture/desktop_capture.rs`
(`Capture::initialize_encoder` / `send_frame_with_audio`) rather than in the v2 options
plumbing. Video-only recording and the webcam sidecar are unaffected.

Reproduce with:

```bash
pnpm cli record monitor --duration 2500 --audio --json
```

## Develop requirements

- Install the latest `Rust`
- Install `Node.js@10+` which fully supported `Node-API`
- Install `yarn@1.x`

## Test in local

```bash
yarn
yarn build
yarn test:all
```

## Distribution

`velocity` is not published to npm. It ships inside the `recso` Electron app:
`electron-builder.json` bundles `velocity/index.js` and `velocity/*.node`, and the main
process resolves the addon by path (see `getVelocityCursorBindings` in
`src/electron/services/mouse-tracker.service.ts`). The `.node` binary is gitignored, so
run `pnpm build` before packaging a release.
