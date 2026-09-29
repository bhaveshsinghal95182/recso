# Automation API

Goal: advanced users can drive recso from scripts, other apps and AI agents. They can start and stop recordings, find and open projects, export, and react to what happened, through one local, versioned API with three front doors: a socket, a CLI (`recso-cli`) and an MCP server. It is **off by default** and invisible until turned on, so nobody else sees a change.

The proof is dogfooding: `~/Work/video-workflow` (the user's GTK app that points OBS, Audacity and Resolve at one folder per video) gains a "Record with recso" tool. An agent builds it using only the published docs, not recso's source.

Work happens on `feat/automation-api`, branched from `feat/linux-port`. **The feature ships on Windows and Linux alike**: every method, the CLI, MCP, hooks, the settings toggle and packaging exist on both. This machine dual-boots Windows, so development happens on Linux, where everything is run end to end. Windows is covered by code written for it, unit tests of its platform branches run here, and type checks. One run of `pnpm check:automation` on Windows by the user finishes it (milestone W).

## Principles

- **Opt-in.** Turned on in Settings ▸ Advanced ▸ Automation API, or for development and tests with `RECSO_AUTOMATION=1`. While it is off, no socket exists, and the CLI exits with code 3 and says how to turn it on. The setting persists.
- **Local only.** A Unix socket at `$XDG_RUNTIME_DIR/recso/api.sock`, directory mode 0700 and socket mode 0600; refuse to start if the directory belongs to another user. On Windows, a per-user named pipe `\\.\pipe\recso-api-<username>`. No TCP listener in v1.
- **One core, three doors.** A method registry in `src/electron/automation/` holds each method's name, description, input and output JSON Schema and handler. Handlers call the same services the IPC handlers call, never parallel copies. The socket, the CLI and MCP are thin adapters over the registry. The registry is also the source for `api.describe`, the MCP tool list and the method table in the docs.
- **Versioned contract.** `api.version` returns `{ api: "1.0", app }`. Adding a method or an optional field bumps the minor version; removing or changing one bumps the major version and gets a Log entry. Method names are dotted and stable.
- **The UI stays the source of truth.** A recording started over the API shows in recso's recorder like one started with the button (timer, stop, tray), and either side can stop it. **Recording is never hidden**: an API call can't start a recording that the user can't see.
- **No plugin code runs inside recso.** Extensibility is the API, events and hooks (commands the user lists in a config file). No in-process plugins means no ABI to maintain, and a broken extension can't crash a recording.
- **Nothing destructive in v1.** No method deletes files. Exports refuse to overwrite an existing file unless given `overwrite: true`. Paths must be absolute, and project methods only accept folders that contain `.recso/project.json`.
- **Windows parity.** Nothing is Linux-only unless the platform forces it (the portal restore token), and then `api.describe` says so per platform. Platform differences sit behind small functions that take the platform as a parameter (`transportPath(platform, env)`, `configDir(platform, env)`, `hookSpawnArgs(platform, command)`), so both branches are unit-tested on Linux.
- **Permissive dependencies only**, as in the Linux port: check the license of every new package. A dependency-free CLI and MCP adapter is preferred.

## Design

### Wire protocol

JSON-RPC 2.0, one JSON object per line, over the socket. A client may send `events.subscribe`, after which the server writes JSON-RPC notifications (no `id`) on that connection. Errors use JSON-RPC codes plus recso's own codes, each with a stable `data.reason` string (`api_disabled`, `not_recording`, `already_recording`, `not_a_project`, `output_exists`, `engine_unavailable`, `cancelled`, ...). A Python client needs about 20 lines of stdlib code; `docs/automation/` includes one.

### Methods (v1 target)

| Method                                                                     | Does                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.version`, `api.describe`                                              | Versions; every method with its description and schemas                                                                                                                                                                                                                                                        |
| `app.status`                                                               | App version, platform, engine available, encoders (`nvenc`/`openh264`), recording state, the project open in the editor                                                                                                                                                                                        |
| `app.show`                                                                 | Brings the window forward (launching is the CLI's job, see below)                                                                                                                                                                                                                                              |
| `settings.get`, `settings.set`                                             | Only an allowlist: `recording.outputDir`, `recording.systemAudio`, `recording.mic`, `recording.micDeviceId`, `recording.camera`, `recording.cameraDeviceId`, `export.outputDir`, `export.preset`. The recorder UI reflects the change straight away. This is recso's equivalent of OBS's `SetRecordDirectory`. |
| `devices.list`                                                             | Microphones, cameras, capture sources (on Linux: the portal source and whether a source is remembered)                                                                                                                                                                                                         |
| `recording.start`                                                          | Optional overrides of the settings above plus `fileName`, `rememberSource`. Returns `{ recordingId, videoPath }`                                                                                                                                                                                               |
| `recording.stop`, `recording.pause`, `recording.resume`, `recording.state` | `stop` returns `{ projectDir, videoPath, cameraPath?, durationMs, clicks }` once the file is finalised                                                                                                                                                                                                         |
| `sources.forget`                                                           | Clears a remembered portal source                                                                                                                                                                                                                                                                              |
| `projects.list`, `projects.get`                                            | Recent projects and projects under a folder; one project's duration, tracks, thumbnail and exports                                                                                                                                                                                                             |
| `projects.open`                                                            | Opens a project in the editor                                                                                                                                                                                                                                                                                  |
| `export.start`                                                             | `{ projectDir, output?, preset?, encoder?, overwrite? }` → `{ exportId, output }`. Uses the project's saved edits                                                                                                                                                                                              |
| `export.progress`, `export.cancel`                                         |                                                                                                                                                                                                                                                                                                                |
| `events.subscribe`                                                         | Notifications: `recording.started`, `recording.stateChanged`, `recording.stopped`, `export.progress`, `export.finished`, `export.failed`, `project.saved`, `settings.changed`                                                                                                                                  |

Long waits: `recording.stop` and `export.start` take `wait: true`, and there's `export.wait({ exportId, timeoutMs })`, because MCP clients can't hold a subscription.

Later (not v1, noted so the design leaves room): editing a project's decisions over the API (background, padding, cuts, zoom regions) through an allowlisted patch of `project.json`.

### Recording without a person at the picker

On Linux every recording opens the xdg-desktop-portal picker. That is right for a person, but an agent-driven "record now" should not need a click every time. `rememberSource: true` asks the portal for `persist_mode = persistent` and stores the restore token in recso's settings; later starts reuse it until `sources.forget` or until the portal rejects it (then the picker shows again). This changes the M3 decision in `docs/linux-port.md` ("not persisted") only for this opt-in, and the button in the UI keeps asking every time. Tests keep using `VELOCITY_TEST_PIPEWIRE_NODE`.

### Exports without the editor

`--export-project` already exports headlessly through a hidden renderer, which computes the export from the project's saved edits. `export.start` reuses that path. While the app is running, it uses a hidden window or the running renderer, without disturbing the editor. When the app isn't running, `recso-cli export` launches the app headlessly. Find out whether the renderer is really needed. If the options can be built in main from `project.json`, API exports get simpler, but don't fork the logic that turns edits into export options.

### Hooks

`automation.json` in recso's config directory (Linux: `~/.config/recso/`):

```json
{
  "hooks": {
    "recording.stopped": [["/path/to/cmd", "arg"]],
    "export.finished": [["notify-send", "recso", "Export done"]]
  }
}
```

Each command runs without a shell and gets the event as JSON on stdin, plus `RECSO_EVENT`, `RECSO_PROJECT_DIR` and `RECSO_OUTPUT` in its environment. It is killed after 60 s, and a failure is logged but never breaks recso. Hooks come **only** from this file, never from an API call. They run only while the Automation API is on.

### CLI

`recso-cli` is a dependency-free Node ESM script. Its subcommands mirror the registry: `status`, `record start|stop|pause|resume|state`, `projects list|get|open`, `export <projectDir> [--out] [--wait]`, `settings get|set`, `devices`, `events` (prints one notification per line), `call <method> [json]`, `describe` and `mcp`. It prints human-readable output by default and uses `--json` for machines. Exit codes: 0 ok, 1 method error, 2 usage, 3 app not running or API disabled. `--launch` starts recso when it isn't running and waits for the socket.

Packaging: in development it runs as `pnpm recso …`. In the packaged app the script ships in `resources/`, and it runs with the app's own binary as Node (`ELECTRON_RUN_AS_NODE=1`). The deb installs a `/usr/bin/recso-cli` wrapper. The AppImage needs a documented way in; pick one and log it.

### MCP server

`recso-cli mcp` is an MCP server over stdio. Each registry method becomes a tool, with its description and input schema from the registry, and the `wait` variants cover long operations. Write it without the SDK if that stays small (MCP is JSON-RPC over stdio: `initialize`, `tools/list`, `tools/call`); otherwise use `@modelcontextprotocol/sdk` (MIT). Setup: `claude mcp add recso -- recso-cli mcp` and a `.mcp.json` example.

### Windows

| Piece                     | Linux                                                  | Windows                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport                 | Unix socket, 0600                                      | Named pipe `\\.\pipe\recso-api-<username>` (Node's `net` handles both). Check the pipe's default ACL: if another user could open it read-write, restrict it or require a token read from a file in the user's profile                                                                         |
| Config and hooks file     | `~/.config/recso/automation.json`                      | `%APPDATA%\recso\automation.json` (both are `app.getPath('userData')`)                                                                                                                                                                                                                        |
| Hooks                     | `spawn` without a shell                                | The same for `.exe`. Node refuses `.bat`/`.cmd` without a shell, so run those through `cmd.exe /d /s /c` with careful quoting, or document executables only                                                                                                                                   |
| Sources                   | Portal picker; opt-in restore token                    | `devices.list` returns screens and windows with ids, so `recording.start({ sourceId })` needs no picker. `rememberSource` is reported as unsupported                                                                                                                                          |
| Encoders in `app.status`  | `nvenc`, `openh264`                                    | What the Media Foundation exporter offers                                                                                                                                                                                                                                                     |
| CLI                       | deb: `/usr/bin/recso-cli`; AppImage: documented way in | NSIS installs `recso-cli.cmd` next to `recso.exe` (`ELECTRON_RUN_AS_NODE=1` + the script, as VS Code's `code.cmd` does) and offers to add it to `PATH`. MSIX can't set environment variables through an app execution alias; find a way (for example a tiny launcher) or log it as a decision |
| Paths                     | `path.posix`                                           | Validate with `path.win32`, drive letters and UNC paths included                                                                                                                                                                                                                              |
| Python client in the docs | `AF_UNIX`                                              | `open(r'\\.\pipe\…', 'r+b')`; the docs show both                                                                                                                                                                                                                                              |

video-workflow (A6) is Linux-only (GTK, Hyprland), but the agent guide's patterns and examples have to cover Windows too.

### Docs for people and for agents

- `docs/automation/README.md`: turning it on, the socket, the method table (generated from, or checked against, the registry), events, hooks, the CLI, MCP, the Python client and the security model.
- `docs/automation/agent-guide.md`, written for agents (follow the `writing-for-agents` skill). It covers how to discover the API (`recso-cli describe`) and the integration patterns: "point recso's output at my app's folder", "record now and hand me the file", "export into folder X when the user is done", "react to `recording.stopped`". It explains how to check that recso is installed and the API is on, and how to fail gracefully when it isn't.
- `pnpm check:automation-docs` fails when the docs and the registry disagree (like `check:board`).

## Milestones

Each milestone has to pass its check before it is ticked, **including its Windows part**: the Windows code is written, its platform branches are unit-tested here, and `pnpm typecheck` passes. Commit every verified step.

- [ ] **A0: the core.** Registry, JSON-RPC framing, the socket server behind the opt-in (env var for now), `api.version`, `api.describe`, `app.status`. `recso-cli status|describe|call`. Unit tests: framing (partial lines, several messages in one chunk, bad JSON), schema validation, socket permissions, and "off means no socket". Windows: the named pipe server and client, and the pipe path and ACL decision.
- [ ] **A1: recording.** `settings.*`, `devices.list`, `recording.*`, `sources.forget`, and the portal restore token. The recorder UI follows API changes and API recordings (checked over CDP: the timer runs and the stop button stops it). Check end to end with the dev app, `RECSO_AUTOMATION=1` and a PipeWire test node: `recso-cli record start` into a temp dir, wait 5 s, `record stop` returns a project whose MP4 decodes (ffprobe as a dev tool: H.264 and Opus, about 5 s). Windows: `devices.list` returns WGC screens and windows, and `recording.start({ sourceId })` goes through the same `RecorderService` path as the button.
- [ ] **A2: projects and export.** `projects.*`, `export.*` while the app is running, and `recso-cli export --launch` while it isn't. Check: the project from A1 exports to a chosen path, NVENC is picked on this machine, the output decodes, and `overwrite` is enforced. Windows: `app.status` reports the Media Foundation encoders, and the export goes through the D3D11 engine's existing exporter.
- [ ] **A3: events and hooks.** `events.subscribe` and `recso-cli events`; hooks from `automation.json`. Check: a hook script writes the event it received to a file after a real record, stop and export. Windows: hook spawning for `.exe`, `.cmd` and `.bat`, unit-tested with `platform = 'win32'`.
- [ ] **A4: MCP and the agent guide.** `recso-cli mcp` and `docs/automation/`. Check: a scripted MCP client (initialize, tools/list, tools/call) runs status → record → stop → export. Then run one real headless agent (`claude -p` with only the recso MCP server configured) that reports `app.status`. The guide and the Python and `.mcp.json` examples cover Windows.
- [ ] **A5: product surface.** Settings ▸ Advanced ▸ Automation API toggle (off by default; on starts the socket immediately, off stops it and closes connections), and an "API connected" hint while a client is attached. The CLI goes into the AppImage and the deb. `pnpm check:automation` runs the A1–A4 end-to-end checks in one command. `pnpm check:automation` is a Node script that runs on both platforms: on Linux it uses a PipeWire test node; on Windows it records the primary screen, which needs no picker. The CLI goes into the NSIS installer (`recso-cli.cmd`, optional `PATH`) and, if it can, the MSIX. Check: `pnpm dist:linux`, then the AppImage's CLI drives the AppImage; `electron-builder.json` and the NSIS script are updated for Windows (they can't be built here: `dist:win` needs the Windows engine build).
- [ ] **A6: dogfood in video-workflow.** `~/Work/video-workflow` isn't under version control. First `git init` there and commit its current state untouched, then work on a branch `recso-integration`. **Don't run `install.sh`**: the installed copy is what the user runs, and they decide when to install. Build the integration using only `docs/automation/` and `recso-cli describe`, as the user's own agent would; if the docs weren't enough, fix the docs in recso and log it. The integration: a "recso" row in the Apps group that points `recording.outputDir` at `<Video>/Recso/` and `export.outputDir` at `<Video>/Media/Footage/`, then launches or focuses recso. Finished exports then show up in the file list, as OBS recordings do. The row is hidden or explains itself when recso isn't installed or the API is off. Check: run the app from the folder, then over the API record, stop and export; the MP4 lands in `Media/Footage/`.
- [ ] **W: Windows verification (needs the user to boot Windows).** Before handing over, write a short checklist under this milestone. On Windows: `pnpm install`, `pnpm build:engine`, `pnpm test`, `pnpm check:automation`, `pnpm dist:win`, then the installed `recso-cli status` and `record start` / `stop` / `export`. The goal is done when A0–A6 are ticked and this checklist is ready; the run itself is the user's.

## Working on it

- Node 24: `mise exec -- pnpm …`. Before ticking a milestone, `pnpm typecheck`, `pnpm lint:fast` and `pnpm test` must pass. If Rust changed (the restore token), `cargo test --lib` in `velocity/` and `velocity/scripts/check-windows.sh` must pass too. Write platform-specific TypeScript as functions of `platform` and test both values; never guard a Windows branch with a comment saying it's untested without also adding the test. Build the Linux addon with `pnpm build:engine:linux`; it must never regenerate `velocity/index.js` or `index.d.ts`.
- Driving the app unattended: see "Working on the port" in `docs/linux-port.md` (a PipeWire test node, `--remote-debugging-port`, CDP with real `Input.dispatchMouseEvent` clicks). Kill the dev app with `pkill -f "[e]lectron/dist/electron \."`.
- Self-contained modules with a clear interface can go to the `codex` agent: JSON-RPC line framing, the CLI argument parser, the MCP stdio adapter, the hook runner and the docs/registry checker. **Commit your own work before delegating** (it once reverted uncommitted files), and review what it writes.

## Log

Newest first. Record decisions and open questions for the user here.

- 2026-09-30: The user: every new feature ships on Windows as well as Linux. The plan now covers Windows in every milestone and ends with milestone W, a run on Windows by the user.

- 2026-09-30: Plan written. Design choices made without asking, which the user can overturn: Unix socket rather than a localhost WebSocket (file permissions replace a password, and Python's stdlib speaks it); no in-process plugins; hooks only from a config file; opt-in portal restore token for API recordings; recso projects live in `<Video>/Recso/` and exports land in `Media/Footage/`, so Resolve only sees finished videos.
