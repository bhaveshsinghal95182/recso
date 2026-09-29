# Driving recso from an agent

For an AI agent using recso through MCP (`recso-cli mcp`) or `recso-cli`. The [README](README.md) covers setup, the [reference](reference.md) every parameter.

## Before anything

1. Call `app_status`. If `recso_launch` is the only tool, or a tool answers "recso is not running, or its Automation API is off", call `recso_launch`; the other tools appear once recso answers. With `recso-cli`, exit code 3 means the same; add `--launch`. If launching fails too, ask the person to turn on **Settings ▸ Advanced ▸ Automation API** in recso; you can't turn it on yourself.
2. `app_status` tells you the platform (`linux` or `win32`), whether a recording is running (`recording.state`), and which encoders exist.
3. Use absolute paths everywhere. `~` and relative paths are refused with `invalid_params`.

## Record

```text
recording_start { outputDir: "/abs/folder", fileName: "take-1", mic: false, systemAudio: false }
  … let the person do the thing being recorded …
recording_stop  {}   → { projectDir, videoPath, durationMs, … }
```

- Options you leave out come from recso's settings (`settings_get`); set `mic`, `systemAudio` and `camera` explicitly when it matters, because the person's defaults may differ.
- recso's own window shows the recording, and the person can stop it with recso's button. If they do, `recording_stop` fails with `not_recording`; call `recording_state`, or `projects_list` with `dir` set to the output folder, to find the project.
- Only one recording at a time: `already_recording` means one is running; ask before stopping someone else's.
- `recording_pause` and `recording_resume` always fail with `not_supported`. Record separate takes instead.

**Linux:** the desktop asks the person which screen or window to record (the xdg-desktop-portal picker), and `recording_start` waits until they choose. Tell the person to expect it. If they close it, the call fails with `cancelled`. To ask only once, pass `rememberSource: true`; later starts with `rememberSource: true` reuse that choice until `sources_forget`, or until the desktop refuses it (then the picker shows again). `devices_list` returns one source of kind `portal`; there are no ids to pick from.

**Windows:** there is no picker. `devices_list` returns the screens and open windows with ids; pass one as `sourceId`, or leave it out for the primary screen. `rememberSource` is ignored.

## Find and open projects

- `projects_list {}`: recso's recent projects, newest first. `projects_list { dir: "/abs/folder" }`: every project directly inside a folder.
- `projects_get { projectDir }`: duration, size, whether it has edits, and its exports.
- `projects_open { projectDir }` shows it in recso's editor for the person. It fails with `busy` while recording.

A project is a folder holding `.recso/project.json`. Don't edit files in it; recso owns them.

## Export

```text
export_start { projectDir: "/abs/project", wait: true }   → { state: "finished", output: "/abs/…mp4", … }
```

- Without `output`, the MP4 goes to the `export.outputDir` setting (or the project's `exports/` folder), named after the project and numbered rather than overwriting.
- With `output`, an existing file fails with `output_exists`; pass `overwrite: true` only if replacing it is what the person wants.
- Exports take roughly real time or less on a GPU and longer without one. `wait: true` returns when it's done or when `timeoutMs` passes (then `state` is still `running`); keep waiting with `export_wait { exportId }` or poll `export_progress`. `export_cancel` stops one and deletes the partial file.
- The export uses the edits saved in the project, as the editor's Export button would. It doesn't need the editor open and doesn't disturb it.
- A result whose `state` is `failed` has an `error`; report it to the person rather than retrying the same call.

## Settings

`settings_get` and `settings_set { values: { … } }` read and change: `recording.outputDir`, `recording.systemAudio`, `recording.mic`, `recording.micDeviceId`, `recording.camera`, `recording.cameraDeviceId`, `export.outputDir`, `export.preset`. The recorder window shows changes straight away. They last until recso quits; set them again in each session that relies on them.

## When a call fails

The error's `reason` (in MCP, the start of the error text: `<reason>: <message>`) says what to do:

| reason                                                | Do                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| (not running)                                         | `recso_launch`, or ask the person to start recso and turn on the API. |
| `invalid_params`                                      | Fix the arguments; the message lists each problem.                    |
| `already_recording` / `not_recording` / `busy`        | Check `recording_state` and act on what's actually happening.         |
| `cancelled`                                           | The person closed the picker. Ask before trying again.                |
| `source_unavailable`                                  | Call `devices_list` again; the window may have closed.                |
| `not_found` / `project_not_found` / `invalid_project` | Check the path with `projects_list`.                                  |
| `output_exists`                                       | Choose another `output`, or ask before passing `overwrite: true`.     |
| `recording_failed`, `internal_error`                  | Tell the person the message; don't loop.                              |

Don't retry a failing call in a loop. Two failures with the same reason mean something the person has to look at.
