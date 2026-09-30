# recso Automation API

recso can be driven by other programs: start and stop recordings, list and open projects, export them, and hear what happens. It is for scripts, other apps on the same computer, and AI agents.

The API is **off by default**. While it is off, recso opens no socket, starts no listener, and behaves exactly as if the API didn't exist.

- [Turn it on](#turn-it-on)
- [recso-cli](#recso-cli)
- [MCP (for AI agents)](#mcp-for-ai-agents)
- [The protocol](#the-protocol) · [Errors](#errors)
- [Events](#events) · [Hooks](#hooks)
- [Examples](examples/) · [Reference](reference.md) (every method, parameter, event and setting) · [Agent guide](agent-guide.md)

## Turn it on

In recso: **Settings ▸ Advanced ▸ Automation API**. It takes effect at once and stays on across restarts. While a program is connected, recso shows "API connected" next to the switch.

For a single run instead, start recso with `RECSO_AUTOMATION=1` in its environment (`RECSO_AUTOMATION=0` forces it off).

Only programs running as **your user** on **this computer** can connect:

|         | Where                                                                                                                        | Who can connect                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Linux   | Unix socket `$XDG_RUNTIME_DIR/recso/api.sock` (without `XDG_RUNTIME_DIR`: `/tmp/recso-<user>/api.sock`)                      | The socket is `0600` in a `0700` directory: your user only.            |
| Windows | Named pipe `\\.\pipe\recso-api-<user>` (characters other than letters, digits, `.`, `_` and `-` in the user name become `_`) | Your user, SYSTEM and Administrators; other users can't send requests. |

`RECSO_AUTOMATION_SOCKET` overrides the path (on Windows, the pipe name) for both recso and `recso-cli`, for tests that run a second copy.

There is no password or token: being able to open the socket or pipe is the permission.

## recso-cli

A command-line client that ships with recso.

| Install           | Command                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux `.deb`      | `recso-cli` (on `PATH`, in `/usr/bin`)                                                                                                                                     |
| Linux AppImage    | `./recso-<version>.AppImage --cli <command>`; an alias helps: `alias recso-cli='~/Applications/recso.AppImage --cli'`                                                      |
| Windows installer | `recso-cli` (`recso-cli.cmd` in recso's install folder; the installer offers to add that folder to your `PATH`; otherwise `"%LOCALAPPDATA%\Programs\recso\recso-cli.cmd"`) |
| Microsoft Store   | Not included yet: install from the installer to use the API.                                                                                                               |
| From source       | `pnpm recso <command>` after `pnpm transpile:electron`                                                                                                                     |

```sh
recso-cli status                        # is recso running, is the API on, what is it doing
recso-cli record start --out ~/Videos/Recso --name demo --no-mic
recso-cli record stop                   # prints the new project's folder
recso-cli projects list
recso-cli export ~/Videos/Recso/demo --wait    # prints the MP4's path when done
recso-cli events                        # one JSON event per line until Ctrl-C
recso-cli describe                      # every method and event, with schemas
recso-cli call settings.get '{"keys":["export.outputDir"]}'
```

- `--json` prints results (and errors) as JSON, for scripts.
- `--launch` starts recso first if it isn't running (in the background, window hidden until something shows it) and waits up to `--timeout` ms (default 30000) for the API. The API still has to be on in recso's settings, or `RECSO_AUTOMATION=1` has to be in the environment `recso-cli` runs in; if it's off, recso opens its window as usual and `recso-cli` exits 3 once the timeout passes. `recso-cli` finds the recso it belongs to; `RECSO_APP=/path/to/recso` points it at another one.
- Exit codes: `0` success, `1` the method failed (the error says why), `2` bad command line, `3` recso isn't running, its API is off, or the connection dropped.

`recso-cli help` lists every command; the full usage is in the [reference](reference.md#recso-cli).

## MCP (for AI agents)

`recso-cli mcp` is an MCP server over stdio. Every API method is a tool, named with `_` for `.` (`recording.start` → `recording_start`), with the same description and input schema. There is also `recso_launch`, which starts recso if it isn't running. Events aren't tools; long operations have `wait` forms instead (`export_start` with `wait: true`, `export_wait`).

Claude Code:

```sh
claude mcp add recso -- recso-cli mcp
```

Or in a project's `.mcp.json` (see [examples/mcp.json](examples/mcp.json)):

```json
{
  "mcpServers": {
    "recso": { "command": "recso-cli", "args": ["mcp"] }
  }
}
```

On Windows, MCP clients start servers without a shell, and a `.cmd` needs one: use `cmd` as the command.

```sh
claude mcp add recso -- cmd /c recso-cli mcp
```

```json
{
  "mcpServers": {
    "recso": { "command": "cmd", "args": ["/c", "recso-cli", "mcp"] }
  }
}
```

Without `recso-cli` on `PATH`, put the full path to `recso-cli.cmd` in its place. With the AppImage, `command` is the AppImage and `args` is `["--cli", "mcp"]`.

The [agent guide](agent-guide.md) is written for the agent itself: what to call, in what order, and what the errors mean.

## The protocol

JSON-RPC 2.0, one JSON object per line (UTF-8, `\n`-terminated), in both directions. Any language that can open a Unix socket or a named pipe can use it; [examples/recso_client.py](examples/recso_client.py) is a complete client in standard-library Python for both platforms.

```text
→ {"jsonrpc":"2.0","id":1,"method":"recording.start","params":{"outputDir":"/home/me/Videos/Recso","fileName":"demo","mic":false}}
← {"jsonrpc":"2.0","id":1,"result":{"recordingId":"…","sourceId":"screen:portal","videoPath":"/home/me/Videos/Recso/demo/demo.mp4","rememberedSource":false}}
```

- Several requests can be in flight on one connection; responses carry the request's `id` and may come back in any order.
- A message without an `id` is a notification: recso never answers it.
- `api.version` returns the API version; `api.describe` returns every method with JSON Schemas for its params and result, and every event with its payload schema. Programs can check `api` (currently `1.0`): a change that breaks callers changes the major version.
- Paths are always absolute, in and out.
- Batches (arrays of requests) aren't supported.

## Errors

A failed call returns a JSON-RPC error whose `data.reason` says what went wrong in a word a program can switch on; `message` is for people.

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32000,
    "message": "/home/me/out.mp4 already exists; pass overwrite: true to replace it",
    "data": { "reason": "output_exists" }
  }
}
```

| `reason`                                                | Meaning                                                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `parse_error`, `invalid_request`, `batch_not_supported` | The message wasn't a single valid JSON-RPC request.                                                            |
| `method_not_found`                                      | No such method (check `api.describe`).                                                                         |
| `invalid_params`                                        | A parameter is missing, has the wrong type, or a path isn't absolute. `data.problems` lists each problem.      |
| `already_recording`, `not_recording`, `busy`            | The recorder isn't in the state the call needs (`busy`: `projects.open` while recording).                      |
| `cancelled`                                             | Linux: the person closed the screen picker.                                                                    |
| `source_unavailable`                                    | The `sourceId` isn't a screen or window recso can see now (see `devices.list`).                                |
| `recording_failed`                                      | The recorder couldn't start or finish; `message` has its error.                                                |
| `not_supported`                                         | The call can't work here, such as `recording.pause` (the recorder can't pause) or `events.subscribe` over MCP. |
| `not_found`, `project_not_found`, `invalid_project`     | The folder doesn't exist, or holds no readable recso project.                                                  |
| `output_exists`, `output_busy`                          | The export's output file exists (pass `overwrite: true`), or another export is writing it.                     |
| `export_not_found`                                      | No export with that `exportId` since recso started.                                                            |
| `internal_error`                                        | A bug in recso; the log has details.                                                                           |

`recso-cli` prints `Error (<reason>): <message>`, or with `--json`, `{"error":{"reason":…,"code":…,"message":…}}`.

## Events

`events.subscribe` (all events, or `{"events": [...]}` for some) makes recso send notifications on that connection:

```text
← {"jsonrpc":"2.0","method":"recording.stopped","params":{"recordingId":"…","success":true,"projectDir":"/home/me/Videos/Recso/demo","videoPath":"/home/me/Videos/Recso/demo/demo.mp4","durationMs":5190,"clicks":0,"error":null}}
```

Events report what happened whoever caused it: a recording started with recso's own button raises the same `recording.started` as one started over the API. The events are `recording.started`, `recording.stateChanged`, `recording.stopped`, `project.saved`, `export.progress`, `export.finished`, `export.failed` and `settings.changed`; their payloads are in the [reference](reference.md#events). `recso-cli events [name...]` prints them as `{"event": …, "data": …}` lines.

## Hooks

Hooks run a program when an event happens, without anything connected. They are read from `automation.json` in recso's settings folder:

- Linux: `~/.config/recso/automation.json`
- Windows: `%APPDATA%\recso\automation.json`

```json
{
  "hooks": {
    "recording.stopped": [["/home/me/bin/on-recording", "--notify"]],
    "export.finished": [["notify-send", "recso", "Export done"]]
  }
}
```

Each event maps to a list of commands; a command is the program and its arguments. recso runs it:

- **without a shell**: no `~`, `$VAR`, globs or pipes (write a script for those);
- with the event on **stdin** as one line of JSON, `{"event": "…", "data": {…}}` (the same payload as the event);
- with `RECSO_EVENT` (the event name), `RECSO_PROJECT_DIR` (the project folder, when the event has one) and `RECSO_OUTPUT` (the file it produced: the export's MP4, or the recording's video) in its environment;
- for at most **60 s**, after which it is stopped; at most 8 hooks run at once.

On Windows, `.exe` programs run directly; `.cmd` and `.bat` files run through `cmd.exe`, and their arguments can't contain `"` or `%` (use an `.exe` or `powershell.exe -File script.ps1` for those).

Hooks only come from this file (the API can't add them), run only while the Automation API is on, and are re-read when the file changes. A hook that fails is logged in recso's log and never affects recso.
