# Export image corruption: encoder surface lifetime

Investigated September 20, 2026 against the September 18 recording and AppX 2.0.0.0.

The installed AppX, previous unpacked bundle, and development native addon initially
had identical SHA256 hashes. A stale packaged addon did not explain the difference.
The reported export had the expected 59,632 frames and approximately 993.86 seconds,
but showed the wrong source images at some timestamps.

## Cause and fix

`velocity/src/engine/encode.rs` copied images into a six-texture ring. `WriteSample`
is asynchronous: its return does not mean the encoder has finished reading the
texture. Submitting six more frames overwrote surfaces still queued for encoding.
Calling D3D `Flush` or waiting for the copy to complete does not establish that the
encoder has consumed the surface. Scheduling and throughput can therefore change
how visibly this fails between development and production.

This is separate from the previously fixed decoder sample lifetime bug.

The encoder now submits the original samples supplied by
`IMFVideoSampleAllocatorEx`, which recycles them after downstream consumers release
them. The GPU pool starts with six samples and is capped at 32. Exhaustion waits
outside the render lock, with a ten-second failure timeout instead of overwriting
in-flight images or allocating unbounded GPU memory.

## Regression and results

Run `python scripts/check-export-frame-order.py` after building the native addon.
Requires Windows, Node, ffmpeg and Python numpy. A binary-coded image number in
each of 600 frames checks actual decoded image order, count, and identity. Preview
runs during export; repeat runs alternate audio and video-only configurations.
Use `--module path/to/velocity.win32-x64-msvc.node` to test a packaged binary.

- Old unpacked production binary: **271 wrong images / 600** with audio.
  Examples: output frames 184, 185, 186 contained images 190, 191, 192.
- Fixed release binary: **0 wrong images / 1,800**, across three exports.
- Electron main-process export service check: passed, including range selection.
- Full source recording re-export with audio: 59,632 frames, 993.862683 seconds of
  video, 993.877313 seconds of audio; completed without exhausting the sample pool.
- Compared 994 one-second thumbnails against the source. The 95th percentile
  mean absolute grayscale error was 0.079 / 255. Three apparent outliers from
  the `fps=1` filter fell at scene transitions; checking all 60 frames in those
  seconds directly gave mean errors below 0.051 / 255. This full export tests the
  native pipeline with the source and audio, not the project's canvas layout.

The installed AppX has not been replaced by this investigation. A rebuilt package
must be installed and tested under package identity before claiming the installed
application is verified. Existing AppX startup/preload edits in the working tree
are separate from this encoder fix.
