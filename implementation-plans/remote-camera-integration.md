# Remote Camera (Phone-as-Webcam) Integration Plan

Date: 2026-05-20

## Goal

Allow a phone on the same network to act as a webcam for Recso via QR pairing, with live preview and recorded camera sidecar compatible with existing editor/export pipelines.

## High-level architecture

- Pairing & signaling service (Electron main): short-lived session IDs + tokens, QR generation.
- Phone (browser): opens pairing page, grants camera permission, publishes media via WebRTC.
- Desktop (Electron renderer/main): accepts WebRTC media, exposes it as a `FrameVideoSource` to the editor engine and as an aux stream to the recorder.
- Recorder writes the camera sidecar using the same naming convention used by native webcam sidecars.

Principles: keep pure logic (session id/token creation, expiry, URL building, layout decisions, naming) in small domain modules; isolate impure adapters (HTTP/HTTPS server, WebSocket/WebRTC signaling, filesystem, IPC) behind thin wrappers.

## Transport recommendation

- Use WebRTC for media transport (low-latency, browser-friendly).
- Use a lightweight secure signaling endpoint (local HTTPS or WebSocket over a secure origin) for mobile browsers to allow getUserMedia.
- Development fallback: non-secure signaling for localhost testing only.

## Files to add

- `src/electron/services/remote-camera-domain.ts` — Pure domain functions (createSessionId, token generation, expiry checks, buildPairingUrl, naming helpers).
- `src/electron/services/remote-camera.service.ts` — Service orchestration (session registry, signaling handlers, attach/detach media track, expose getActiveRemoteCameraSource()).
- `src/electron/ipc/remote-camera.ipc.ts` — IPC handlers: `remoteCamera:startSession`, `remoteCamera:stopSession`, `remoteCamera:getStatus`, `remoteCamera:getQrPayload`.
- `implementation-plans/remote-camera-integration.md` — This plan (just added).

Optional assets for phone pairing page (served by the local server):

- `assets/remote-camera/pair.html` — pairing UI shown on phone
- `assets/remote-camera/pair.js` — lightweight client that negotiates WebRTC and sends offer/answer via signaling

## Files to change (minimal edits)

- `src/electron/main.ts` — start/stop remote-camera service during app lifecycle (thin orchestration).
- `src/electron/preload.cts` & `src/ui/electron.d.ts` — expose new IPC methods safely to renderer.
- `src/electron/services/recorder.service.ts` — integrate remote camera aux stream path; open/close aux stream and write sidecar file like existing `auxStreams.camera` flow.
- `src/ui/store/project-store.ts` — add remote-camera status and actions: `startRemoteCameraPairing`, `stopRemoteCameraPairing`, `refreshRemoteCameraStatus`.
- `src/ui/screens/editor/panels/webcam-panel.tsx` — UI controls to start pairing, show QR, display status, connect/disconnect.
- `src/ui/screens/editor/engine/adapters.ts` — add `createRemoteMediaStreamFrameSource(mediaStream)` (wraps an `HTMLVideoElement` or `MediaStream` to `FrameVideoSource`).
- `src/ui/screens/editor/engine/preview-runtime/session.ts` — when remote session active, call `engine.setWebcamSource(new HtmlVideoCoverFrameSource(remoteVideoEl))`.
- `src/ui/screens/editor/engine/preview-config-mapper.ts` and export-pipeline composition mappers — minor adjustments to accept a remote `stream` descriptor in addition to `sourcePath`.

## Core functions to add (signatures)

In `remote-camera-domain.ts` (pure):

- `createRemoteCameraSessionId(): string`
- `createRemoteCameraToken(): { token: string; expiresAt: number }`
- `buildPairingUrl(sessionId: string, token: string): string`
- `isSessionExpired(expiresAt: number): boolean`
- `inferRemoteCameraSidecarPath(videoPath: string): string` (pure naming helper)

In `remote-camera.service.ts` (impure wrappers):

- `createRemoteCameraSession(opts?): RemoteCameraSession` — creates session object and QR payload
- `destroyRemoteCameraSession(sessionId: string)`
- `getPairingQrPayload(sessionId: string)`
- `handleSignalingMessage(sessionId: string, msg: SignalingMessage)`
- `attachRemoteTrack(sessionId: string, mediaStream: MediaStreamLike)`
- `detachRemoteTrack(sessionId: string)`
- `getActiveRemoteCameraSource(): { kind: 'remote'|'none', stream?: MediaStreamLike, label?: string }`

In `recorder.service.ts` (integration):

- `shouldUseRemoteCamera(): boolean`
- `openRemoteCameraAuxStream()` — open temp file, return AuxStreamState
- `writeRemoteCameraChunk(streamId: string, data: Buffer)` — adapter for renderer to push camera chunks
- `finalizeRemoteCameraSidecar()` — rename/move temp file to final path

In renderer store / UI: thin action wrappers that call IPC.

## Pure functions to keep testable

- session token/id builders: `createRemoteCameraSessionId`, `createRemoteCameraToken`, `buildPairingUrl`
- session-state reducer: `reduceRemoteCameraSessionState(prev, event)`
- sidecar path and naming: `inferRemoteCameraSidecarPath`
- UI mapping: `mapRemoteCameraStatusToUiState`
- preview mapping: `resolveWebcamSourceDescriptor(project, runtimeState)`

## Implementation phases (MVP-first)

### Phase 1 — Scaffolding (pure+IPC)

- Add `remote-camera-domain.ts` and `remote-camera.service.ts` skeleton.
- Add `remote-camera.ipc.ts` with IPC handlers returning fake state.
- Add store actions and webcam panel UI to show QR payload from IPC.
- No real video transport yet. Verify IPC and QR generation.

### Phase 2 — Signaling + pairing page (dev mode)

- Add a local dev signaling server (HTTP or WebSocket) served from Electron main.
- Add `assets/remote-camera/pair.html` and `pair.js` that implement WebRTC offer/answer.
- When phone connects, service attaches a received `MediaStream` and exposes it through IPC.
- Renderer uses `createRemoteMediaStreamFrameSource()` for live preview.

### Phase 3 — Recorder integration

- Feed incoming remote media to recorder aux stream.
- Write camera sidecar using existing naming convention (`<video>_camera.mp4`).
- Validate exported compositions still work with remote camera sidecar.

### Phase 4 — Production hardening

- Use HTTPS (self-signed or loopback trust) for mobile browsers.
- Token rotation, session expiry, reconnection/backoff.
- UI polish and accessibility.

## Testing checklist

- Unit tests for domain pure functions (session id, token expiry, pairing URL building).
- Integration tests for IPC handlers (start/stop session, status reporting).
- Manual test: phone opens QR → pairing page → grants camera → desktop preview shows stream → start recording → camera sidecar file produced and opens.

## Next steps (if you want me to continue)

1. I can implement Phase 1: add domain module, service skeleton, IPC and the MD plan (done).
2. Then implement Phase 2 signaling stubs and dev pairing page.

---

Plan file created at: [implementation-plans/remote-camera-integration.md](implementation-plans/remote-camera-integration.md)
