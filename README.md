# Recso

Recso is a desktop screen recording and editing app for Windows, macOS, and Linux. It records your screen (and optionally your webcam, microphone, system audio, and mouse cursor), then hands you straight into an editor for producing polished, presentation-ready videos — automatic zoom-ins, cursor click effects, webcam overlays, background presets, and timeline trimming — before exporting to a final video file.

Built with Electron, React, and a native Rust capture engine.

## Features

- **Screen & window capture** — record a full monitor or a single window, with system audio and microphone capture, powered by a native Rust capture engine (`velocity`) for low-overhead recording.
- **Webcam overlay** — record your webcam alongside the screen and freely resize/reposition it on a 3x3 anchor grid in the preview.
- **Mouse tracking & cursor effects** — cursor position is tracked during recording so the editor can render custom cursor styles, click animations, and motion blur on export.
- **Automatic & manual zoom** — add zoom regions to a timeline that animate in/out to draw attention to parts of the screen.
- **Backgrounds** — compose the canvas with a solid color, pattern, or image background behind the recording.
- **Timeline editing** — trim/cut sections out of a recording, scrub with a waveform-backed timeline, and preview changes live.
- **Crash-safe recording** — recording metadata is persisted to a local SQLite database so in-progress recordings can be recovered after a crash.
- **Project management** — recordings are saved as local projects with a recent-projects list for quickly resuming past work.
- **Native export pipeline** — the Rust `velocity` engine streams hardware decode, GPU composition, hardware encode, and file output without loading the recording into renderer memory.
- **GPU video engine** — export and preview use the native render chain; preview imports its shared D3D11 texture through Electron without copying frames through JavaScript. See [docs/ENGINE.md](docs/ENGINE.md).
- **System tray integration** — start/stop recordings and access the app from the system tray.
- **Basic usage telemetry** — anonymous, opt-out-friendly telemetry to help understand feature usage (see `src/electron/services/telemetry`).

## Tech Stack

| Layer                          | Technology                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop shell                  | [Electron](https://www.electronjs.org/)                                                                                                 |
| UI                             | [React 19](https://react.dev/), [Vite](https://vitejs.dev/), [TypeScript](https://www.typescriptlang.org/)                              |
| Styling / components           | [Tailwind CSS 4](https://tailwindcss.com/), [Radix UI](https://www.radix-ui.com/), [shadcn](https://ui.shadcn.com/)-style component kit |
| State management               | [Zustand](https://github.com/pmndrs/zustand)                                                                                            |
| Canvas rendering / compositing | [Pixi.js](https://pixijs.com/)                                                                                                          |
| Animation                      | [motion](https://motion.dev/), [animejs](https://animejs.com/), [flubber](https://github.com/veltman/flubber) (shape morphing)          |
| Media encode/decode            | Media Foundation + D3D11 through the native `velocity` engine                                                                           |
| Native capture engine          | Rust + [napi-rs](https://napi.rs/) (local `velocity` package)                                                                           |
| Local storage                  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)                                                                            |
| Packaging                      | [electron-builder](https://www.electron.build/) (NSIS/APPX for Windows, DMG for macOS, AppImage/deb for Linux)                          |

## Project Structure

```
src/
  electron/            # Electron main process
    ipc/                # IPC handlers (recorder, editor, exporter, compositor, tray, ...)
    services/           # Recording, compositing, export, project storage, telemetry, ...
    services/exporter/   # Video export pipeline + filters
    types/               # Shared main-process types
    main.ts              # App entry point
    preload.cts           # Preload script (renderer <-> main bridge)
  ui/                  # Electron renderer (React app)
    screens/
      welcome/           # Landing / project picker screen
      screen-recorder/    # Recording capture UI (camera preview, toolbar, ...)
      editor/             # Post-recording editor
        engine/             # Preview + export rendering engine (canvas layout, zoom, cursor, etc.)
        panels/             # Editor side panels (webcam, cursor, zoom, background, general)
    store/                # Zustand stores
    components/           # Shared UI components
  shared/              # Code shared between main and renderer
velocity/              # Native Rust (napi-rs) screen/window capture module
docs/                  # Troubleshooting and design notes
implementation-plans/  # Design docs for in-progress/planned features
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/)
- Rust toolchain (only needed if you're modifying the native `velocity` capture module)

### Install dependencies

```bash
pnpm install
```

`postinstall` runs `electron-builder install-app-deps` to rebuild native modules (e.g. `better-sqlite3`) against Electron's Node ABI. If you hit a native binding error, see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

### Run in development

Start the Vite dev server and Electron together:

```bash
pnpm dev
```

This runs `dev:react` (Vite) and `dev:electron` in parallel. If you'd rather run them separately (e.g. to restart just the Electron process):

```bash
pnpm dev:react
```

In another terminal:

```bash
pnpm transpile:electron
pnpm dev:electron
```

### Lint & format

```bash
pnpm lint
pnpm lint:fix
pnpm format
```

Pre-commit hooks (via Husky + lint-staged) run ESLint and Prettier automatically, and commit messages are linted with [commitlint](https://commitlint.js.org/) (Conventional Commits).

## Building for Production

```bash
pnpm build            # type-check + Vite production build (dist-react/)
pnpm transpile:electron
```

Then create a platform installer with [electron-builder](https://www.electron.build/):

```bash
pnpm dist:win     # Windows (NSIS + APPX)
pnpm dist:mac     # macOS (DMG, arm64)
pnpm dist:linux   # Linux (AppImage + deb)
```

Build configuration lives in [electron-builder.json](electron-builder.json).

## Other Scripts

| Script                      | Description                                                       |
| --------------------------- | ----------------------------------------------------------------- |
| `pnpm cleanup:db`           | Runs the database cleanup script against the local SQLite store.  |
| `pnpm rebuild:native`       | Rebuilds native dependencies for the current Electron version.    |
| `pnpm build:engine`         | Builds the `velocity` Rust addon, including the GPU video engine. |
| `pnpm engine:check`         | Headless end-to-end check of the GPU video engine.                |
| `pnpm check:webcam-preview` | Hardware check of native webcam preview and recording handoff.    |

The webcam preview uses frames from the native camera owner, including during
recording; it does not open a browser camera stream. The webcam preview check
requires a local Windows webcam and the current `pnpm build:engine` build. It
runs the recording screen in a hidden window, captures briefly, and removes
its isolated test recordings and database afterwards.

## Documentation

- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — fixes for common native module / build issues.
- [docs/blog-webcam-export-optimization.md](docs/blog-webcam-export-optimization.md) — notes on webcam export performance.
- [src/ui/screens/editor/engine/export-pipeline/README.md](src/ui/screens/editor/engine/export-pipeline/README.md) — architecture of the video export pipeline.
- [docs/ENGINE.md](docs/ENGINE.md) — the GPU video engine: a parallel hardware decode/grade/encode path in the `velocity` crate, the recorder metadata that feeds it, and how it is meant to take over from the `<video>` + Pixi path.
- [implementation-plans/](implementation-plans/) — design docs for planned/in-progress features.

## License

No license file is currently published for this repository. All rights reserved by the author unless stated otherwise.
