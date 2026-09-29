#!/usr/bin/env python3
"""A recso Automation API client in standard-library Python, for Linux and Windows.

    python3 recso_client.py                      # app.status
    python3 recso_client.py record 5 /abs/dir    # record 5 s into /abs/dir, then export it

Copy `RecsoClient` into your own program; it has no dependencies.
"""

import getpass
import json
import os
import re
import socket
import sys
import tempfile
import time


def default_path():
    """The socket (Linux) or named pipe (Windows) recso listens on for this user."""
    override = os.environ.get("RECSO_AUTOMATION_SOCKET")
    if override:
        return override
    user = re.sub(r"[^A-Za-z0-9._-]", "_", getpass.getuser()) or "user"
    if sys.platform == "win32":
        return rf"\\.\pipe\recso-api-{user}"
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime:
        return os.path.join(runtime, "recso", "api.sock")
    return os.path.join(tempfile.gettempdir(), f"recso-{user}", "api.sock")


class RecsoError(Exception):
    def __init__(self, error):
        self.reason = (error.get("data") or {}).get("reason", "unknown")
        self.data = error.get("data") or {}
        super().__init__(f"{self.reason}: {error.get('message')}")


class RecsoClient:
    """One request at a time; notifications that arrive meanwhile go to `on_event`."""

    def __init__(self, path=None, on_event=None):
        path = path or default_path()
        try:
            if sys.platform == "win32":
                # A named pipe opens like a file; unbuffered, read and write.
                self._pipe = open(path, "r+b", buffering=0)
                self._sock = None
            else:
                self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                self._sock.connect(path)
                self._pipe = None
        except (FileNotFoundError, ConnectionRefusedError) as error:
            raise ConnectionError(
                "recso is not running, or its Automation API is off "
                "(Settings > Advanced > Automation API)"
            ) from error
        self._buffer = b""
        self._next_id = 0
        self.on_event = on_event or (lambda event, data: None)

    def _send(self, message):
        data = (json.dumps(message) + "\n").encode()
        if self._pipe:
            self._pipe.write(data)
        else:
            self._sock.sendall(data)

    def _read_line(self):
        while b"\n" not in self._buffer:
            chunk = self._pipe.read(65536) if self._pipe else self._sock.recv(65536)
            if not chunk:
                raise ConnectionError("recso closed the connection")
            self._buffer += chunk
        line, self._buffer = self._buffer.split(b"\n", 1)
        return json.loads(line)

    def call(self, method, params=None):
        self._next_id += 1
        request_id = self._next_id
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})
        while True:
            message = self._read_line()
            if "id" not in message:
                self.on_event(message["method"], message.get("params"))
                continue
            if message["id"] != request_id:
                continue
            if "error" in message:
                raise RecsoError(message["error"])
            return message["result"]

    def close(self):
        (self._pipe or self._sock).close()


def main():
    client = RecsoClient(on_event=lambda event, data: print("event", event, json.dumps(data)))
    try:
        if len(sys.argv) >= 4 and sys.argv[1] == "record":
            seconds, out_dir = float(sys.argv[2]), os.path.abspath(sys.argv[3])
            client.call("events.subscribe", {"events": ["recording.stopped", "export.finished"]})
            started = client.call("recording.start", {"outputDir": out_dir, "mic": False})
            print("recording", started["videoPath"])
            time.sleep(seconds)
            stopped = client.call("recording.stop")
            print("project", stopped["projectDir"])
            result = client.call("export.start", {"projectDir": stopped["projectDir"], "wait": True})
            print(result["state"], result.get("output"))
        else:
            print(json.dumps(client.call("app.status"), indent=2))
    except RecsoError as error:
        print(f"recso said {error.reason}: {error}", file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
