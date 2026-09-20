"""GPU regression: verify image identity, not just MP4 timestamps.

Requires Windows, Node, ffmpeg on PATH and Python numpy. Build velocity first.
Usage: python scripts/check-export-frame-order.py [--module PATH] [--runs 3]
The module can also be a packaged resources/velocity directory or .node file (use the .node path for an unpacked bundle).
"""

import argparse
import json
from pathlib import Path
import subprocess
import tempfile

import numpy as np


FRAMES = 600
ROOT = Path(__file__).resolve().parents[1]


def check_frames(path):
    raw = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", str(path), "-vf",
        "crop=1280:128:32:32,scale=10:1:flags=area,format=gray",
        "-f", "rawvideo", "-",
    ], timeout=60)
    pixels = np.frombuffer(raw, np.uint8).reshape(-1, 10)
    ids = ((pixels > 128) * (1 << np.arange(10))).sum(axis=1)
    bad = np.where(ids != np.arange(len(ids)))[0]
    examples = [(int(i), int(ids[i])) for i in bad[:20]]
    print(f"{path.name}: frames={len(ids)}, mismatches={len(bad)}, examples={examples}", flush=True)
    if len(ids) != FRAMES or len(bad):
        raise AssertionError("Export lost, repeated, reordered, or replaced an image")


def run(module, runs, work):
    source = work / "source.mp4"
    encoder = subprocess.Popen([
        "ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", "1920x1080", "-r", "60", "-i", "-", "-f", "lavfi", "-i",
        "sine=frequency=440:sample_rate=48000:duration=10", "-pix_fmt", "yuv420p",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "15", "-g", "60",
        "-bf", "0", "-c:a", "aac", "-shortest", str(source),
    ], stdin=subprocess.PIPE)
    try:
        frame = np.full((1080, 1920, 3), 64, np.uint8)
        for n in range(FRAMES):
            frame[200:800, :, :] = 32 + n % 180
            for bit in range(10):
                frame[32:160, 32 + bit * 128:160 + bit * 128, :] = 235 if n & (1 << bit) else 16
            encoder.stdin.write(frame.tobytes())
        encoder.stdin.close()
        if encoder.wait(timeout=60):
            raise RuntimeError("Fixture encoding failed")
    finally:
        if encoder.poll() is None:
            encoder.kill()
            encoder.wait()
    check_frames(source)
    # Preview and export share the GPU. Exercise both with an unthrottled export.
    # Alternate audio and silent exports to cover both sink writer configurations.
    for attempt in range(runs):
        output = work / f"export-{attempt}.mp4"
        config = json.dumps({"module": str(module), "input": str(source),
                             "output": str(output), "audio": attempt % 2 == 0})
        code = "const config = " + config + ";\n" + r"""
const engine = require(config.module);
const player = new engine.VideoPlayer(config.input);
player.play();
const tick = setInterval(() => player.tick(), 8);
const job = new engine.VideoExporter(config.input, {
  output: config.output, bitrate: 12000000,
  audioSources: config.audio ? [{path: config.input}] : [],
});
const deadline = Date.now() + 60000;
const poll = setInterval(() => {
  const progress = job.progress();
  if (progress.finished || progress.error || Date.now() > deadline) {
    clearInterval(poll); clearInterval(tick); player.close();
    console.log(JSON.stringify(progress));
    process.exit(progress.finished && !progress.error ? 0 : 1);
  }
}, 100);
"""
        subprocess.run(["node", "-e", code], check=True, cwd=ROOT, timeout=75)
        check_frames(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--module", type=Path, default=ROOT / "velocity")
    parser.add_argument("--runs", type=int, default=3)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be positive")
    with tempfile.TemporaryDirectory(prefix="recso-frame-order-") as directory:
        run(args.module.resolve(), args.runs, Path(directory))
