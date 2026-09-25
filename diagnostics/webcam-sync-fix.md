# Webcam / voice timing fix

New webcam captures now use the screen encoder's first Windows Graphics Capture QPC timestamp as their time origin. Frames are stamped after a completed camera read and before preview publishing or encoding. The camera no longer starts an independent clock at its first encoded frame.

The webcam encoder receives a complete frame sequence at the camera's selected frame rate. Black occupies the startup interval before a camera image is available; the previous image occupies a capture stall. This matters because the Windows transcoder was observed backfilling a sparse timestamp gap with a future image.

Preview audio aligns before resume and on paused seeking, corrects differences over 80ms with a seek, and uses a small playback-rate adjustment for differences of 20–80ms. In-progress seeks are left to complete. The old threshold accepted up to 250ms of disagreement.

## Validation

- `cargo test --manifest-path velocity/Cargo.toml --lib --quiet`: 1,657 passed, 2 opt-in tests ignored.
- `pnpm test`: 147 passed.
- `pnpm typecheck`: passed.
- Scoped ESLint and `git diff --check`: passed.
- `pnpm build:engine` and `pnpm build`: passed; the rebuilt native module loads in Node. Restart the running app to load it.
- Explicit Windows encoder/FFmpeg regression: passed. A synthetic camera image first received at 500ms appears at frame 30 of 60fps output; a different image received after a capture stall at 1s appears at frame 60. The previous sparse-gap attempt incorrectly displayed the first image at frame 2.

Run the file-level regression from PowerShell at the repository root (requires FFmpeg and the Windows encoder):

```powershell
New-Item -ItemType Directory -Path diagnostics -Force | Out-Null
$env:RECSO_WEBCAM_TIMING_PROBE="$PWD/diagnostics/webcam-startup-gap.mp4"
cargo test --manifest-path velocity/Cargo.toml --lib encoded_camera_keeps_its_startup_gap -- --ignored --nocapture
```

## Limits

This fixes the identified capture timeline and preview synchronization defects. It does not retroactively recover the unsaved startup offset in an old recording. No source recording or saved project was modified. A new physical microphone/camera recording remains necessary to evaluate any remaining camera exposure, driver, network or audio-device latency. Webcam timing currently uses delivery time because the frame-source API does not provide a hardware capture timestamp.
