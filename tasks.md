# Screen Recording System Implementation

## Phase 1: Core Recording Service ✅

- [x] **1.1 RecorderService Setup**
  - [x] Create `src/electron/services/recorder.service.ts`
  - [x] Define `RecordingState` enum (`IDLE`, `RECORDING`, `PAUSED`)
  - [x] Define `RecordingOptions` interface (frameRate, audioBitrate, videoBitrate)
  - [x] Implement singleton pattern with private state management

- [x] **1.2 getSources()**
  - [x] Use Electron's `desktopCapturer.getSources()`
  - [x] Return list of screens and windows with thumbnails
  - [x] Define `DesktopSource` interface

- [x] **1.3 start(sourceId, options)**
  - [x] Validate sourceId exists
  - [x] Initialize MediaRecorder with stream
  - [x] Set state to `RECORDING`
  - [x] Push state change to renderer

- [x] **1.4 stop()** → Returns saved file path
- [x] **1.5 pause()** → Set state to `PAUSED`
- [x] **1.6 resume()** → Set state to `RECORDING`
- [x] **1.7 getState()** → Return state + duration

---

## Phase 2: Streaming Write System (Crash-Safe) ✅

- [x] **2.1 Temp File Management**
  - [x] Create `src/electron/services/temp-manager.service.ts` (in recorder.service.ts)
  - [x] Generate unique temp paths: `/temp/rec_{uuid}.webm`
  - [x] Track active temp files in SQLite `recordings` table
  - [x] Clean up orphaned temp files on graceful shutdown

- [x] **2.2 Streaming Write in RecorderService**
  - [x] Configure MediaRecorder with `timeslice: 1000` (1 sec chunks)
  - [x] On `ondataavailable`: append chunk to temp file immediately
  - [x] Use `fs.createWriteStream()` in append mode
  - [x] Track bytes written for progress

- [x] **2.3 Mouse Click Flush** (deferred to Phase 7)

- [x] **2.4 Recording Finalization**
  - [x] On stop: close write stream
  - [x] Move temp file to user's chosen location
  - [x] Update SQLite status to `completed`

---

## Phase 3: Crash Recovery System ✅

- [x] **3.1 RecoveryService Setup**
  - [x] Create `src/electron/services/recovery.service.ts`
  - [x] Run on app startup (before main window)

- [x] **3.2 detectOrphanedRecordings()**
  - [x] Query SQLite for recordings where `status != 'completed'`
  - [x] Cross-reference with temp file existence
  - [x] Return list of recoverable recordings

- [x] **3.3 recoverRecording(recordingId)**
  - [x] Move temp file to output location
  - [ ] FFmpeg repair (Phase 11)

- [x] **3.4 Recovery UI Flow** (IPC ready, UI deferred)
  - [x] `getOrphans()` API available
  - [x] `recoverOrphan()` API available
  - [x] `deleteOrphan()` API available

---

## Phase 4: Pre-Recording Settings ✅

- [x] **4.1 RecordingConfig Interface**
  - [x] `fileName`: user-editable, default = `recording_{timestamp}`
  - [x] `outputDir`: user-selected, default = Videos folder
  - [x] `quality`: preset (Low/Standard/High/Ultra) implemented
  - [ ] `backgroundPath`: optional image path (Phase 6)

- [x] **4.2 Settings Dialog IPC**
  - [x] `recorder:show-save-dialog` → open native save dialog
  - [x] `recorder:get-default-output-dir` → return default save location
  - [x] `recorder:validate-output-path` → check write permissions

---

## Phase 5: IPC Layer for Recording ✅

- [x] **5.1 Create recorder.ipc.ts** (done in Phase 1-3)
  - [x] Implement `registerRecorderHandlers()`
  - [x] Instantiate RecorderService singleton

- [x] **5.2 IPC Handlers**
  - [x] `recorder:get-sources` → invoke/handle
  - [x] `recorder:start` → invoke/handle
  - [x] `recorder:stop` → invoke/handle
  - [x] `recorder:pause` / `recorder:resume` → send/on
  - [x] `recorder:state` → push subscription

- [x] **5.3 Register in ipc/index.ts**
- [x] **5.4 Update preload.cts** with `electron.recorder`
- [x] **5.5 Update electron.d.ts** with types

### Additional: Renderer Hook

- [x] **5.6 useScreenRecorder.ts** - React hook for MediaRecorder capture

---

## Phase 6: Compositor Service ✅

- [x] **6.1 CompositorService Setup**
  - [x] Create `src/electron/services/compositor.service.ts`
  - [x] Define `CompositorConfig` (background, padding, scale)

- [x] **6.2 setBackground(imagePath)** → Load and validate
- [x] **6.3 setWindowLayout(bounds, screenDims)** → Calculate scale/offset
- [x] **6.4 createPreviewStream(rawStream)** → Canvas composite
- [x] **6.5 exportWithBackground(rawPath, outputPath, config)** → FFmpeg overlay

---

## Phase 7: Full Mouse Path Tracking (30 FPS) ✅

- [x] **7.1 SQLite Setup**
  - [x] Install `better-sqlite3` (already installed)
  - [x] Updated `src/electron/services/database.service.ts`
  - [x] Enable WAL mode for crash safety: `PRAGMA journal_mode=WAL;`
  - [x] Tables: `recordings`, `mouse_events` (not just clicks)

- [x] **7.2 MouseEvent Schema**

  ```sql
  CREATE TABLE mouse_events (
    id INTEGER PRIMARY KEY,
    recording_id TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL,    -- ms from recording start
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    event_type TEXT NOT NULL,         -- 'move', 'click', 'scroll', 'drag'
    button TEXT,                      -- 'left', 'right', 'middle' (for clicks)
    meta TEXT                         -- JSON for scroll delta, modifiers, etc.
  );
  CREATE INDEX idx_mouse_recording ON mouse_events(recording_id, timestamp_ms);
  ```

- [x] **7.3 MouseTrackerService Setup**
  - [x] Create `src/electron/services/mouse-tracker.service.ts`
  - [x] Install `@mechakeys/iohook` for global mouse hooks
  - [x] Define `MouseEvent` interface with all fields above
  - [x] Configure sampling rate: 30 FPS (33.33ms intervals)

- [x] **7.4 Sampling Logic**
  - [x] Track last sample time, only record if ≥33ms elapsed
  - [x] Always record click/scroll events immediately (bypass sampling)
  - [x] Buffer events in memory array

- [x] **7.5 startTracking(recordingId)**
  - [x] Register global mouse hooks: move, click, scroll, drag
  - [x] Store recording start time for relative timestamps
  - [x] Start 33ms interval timer for position sampling

- [x] **7.6 stopTracking()**
  - [x] Clear interval timer
  - [x] Unregister all mouse hooks
  - [x] Flush remaining buffer to SQLite
  - [x] Return total event count

- [x] **7.7 Periodic Flush (every 1 second)**
  - [x] Batch insert buffered events to SQLite
  - [x] Use transaction for performance
  - [x] Clear buffer after successful flush

- [x] **7.8 Query Methods**
  - [x] `getEventsForRecording(id)` → all events sorted by timestamp
  - [x] `getEventsInRange(id, startMs, endMs)` → for preview scrubbing
  - [x] `deleteEventsForRecording(id)` → cleanup

- [x] **7.9 Mouse Smoothing Utility**
  - [x] Create `src/electron/utils/mouse-smoothing.utils.ts`
  - [x] Implement Catmull-Rom spline interpolation
  - [x] Upsample 30 FPS to 60/120 FPS for smooth rendering
  - [x] Jitter removal filter

---

## Phase 8: Editor Service (Non-Linear)

- [ ] **8.1 Project Model**
  - [ ] Create `src/electron/types/project.types.ts`
  - [ ] `Project`: id, rawVideoPath, recordingId, backgroundPath, timeline, effects
  - [ ] `TimelineTrack`: type (video/audio/overlay), clips[]
  - [ ] `TimelineClip`: sourceStart, sourceEnd, timelineStart, effects[]
  - [ ] `ClipEffect`: type, params (crop, scale, speed, etc.)

- [ ] **8.2 EditorService Core**
  - [ ] Create `src/electron/services/editor.service.ts`
  - [ ] `createProject(rawPath, recordingId)` → new Project
  - [ ] `loadProject(projectPath)` → parse JSON
  - [ ] `saveProject()` → write JSON

- [ ] **8.3 Timeline Operations**
  - [ ] `addClip(track, clip)`
  - [ ] `removeClip(clipId)`
  - [ ] `moveClip(clipId, newPosition)`
  - [ ] `trimClip(clipId, newStart, newEnd)`
  - [ ] `splitClip(clipId, position)`

- [ ] **8.4 Preview Rendering**
  - [ ] `getFrameAt(position)` → seek raw video, apply effects, composite, return ImageData
  - [ ] Use offscreen canvas for real-time preview
  - [ ] Lower resolution for performance (720p preview)

- [ ] **8.5 Export Pipeline**
  - [ ] `exportVideo(outputPath, settings)` → generate FFmpeg filter graph
  - [ ] Apply all timeline edits + effects
  - [ ] Emit progress events
  - [ ] `cancelExport()` → kill FFmpeg process

---

## Phase 9: Editor IPC Layer

- [ ] **9.1 Create editor.ipc.ts**
  - [ ] `editor:create-project` → create from recording
  - [ ] `editor:load-project` / `editor:save-project`
  - [ ] `editor:timeline-*` → all timeline ops
  - [ ] `editor:get-frame` → for preview
  - [ ] `editor:export` / `editor:cancel-export`
  - [ ] `editor:export-progress` → push subscription

- [ ] **9.2 Update preload.cts** with `electron.editor`
- [ ] **9.3 Update electron.d.ts** with types

---

## Phase 10: Project File Structure

- [ ] **10.1 Directory Layout**

  ```
  /recordings/{uuid}/
  ├── raw.webm           # Original recording
  ├── project.json       # Edit decisions
  └── thumbnail.jpg      # Preview
  ```

- [ ] **10.2 Database Schema**
  ```sql
  recordings(id, status, temp_path, final_path, created_at)
  click_events(id, recording_id, timestamp, x, y, button, type)
  ```

---

## Phase 11: FFmpeg Integration

- [ ] **11.1 FFmpeg Setup**
  - [ ] Bundle FFmpeg with app OR use `ffmpeg-static`
  - [ ] Create `src/electron/services/ffmpeg.service.ts`
  - [ ] Wrapper for common operations

- [ ] **11.2 FFmpeg Operations**
  - [ ] `repair(inputPath, outputPath)` → crash recovery
  - [ ] `overlay(video, background, outputPath, layout)` → composite
  - [ ] `trim(inputPath, start, end, outputPath)`
  - [ ] `concat(clips[], outputPath)`
  - [ ] `applyFilters(inputPath, filterGraph, outputPath)`

---

## Phase 12: UI Integration (Pseudo Phase) ✅

- [x] **12.1 Pre-Recording UI**
  - [x] Source selection with thumbnails
  - [x] Add "Refresh Sources" button
  - [x] Settings panel (name, path, quality, background)

- [x] **12.2 Recording Controls**
  - [x] Start/Stop/Pause/Resume buttons
  - [x] Live preview with composite (Note: Live preview is implicit via source selection for now)
  - [x] Timer display

- [ ] **12.3 Post-Recording Flow**
  - [ ] Show dialog: "Open in Editor" / "Quick Export" / "Save Raw"
  - [ ] Navigate to editor screen with recording ID

---

## Phase 13: Editor Preview Screen (Simplified)

- [ ] **13.1 Editor Screen Component**
  - [ ] Create `src/ui/components/screens/editor/editor.tsx`
  - [ ] Route to this screen after recording stops (if user chooses Editor)
  - [ ] Receive `recordingId` via route params or context

- [ ] **13.2 Video Rendering Canvas**
  - [ ] Create canvas element sized to target output (e.g., 1920×1080)
  - [ ] Load video element with raw `.webm` file
  - [ ] Load background image (user-selected or default color)

- [ ] **13.3 Rendering Logic (Centering/Scaling)**

  ```
  ┌────────────────────────────────────────┐
  │            Canvas (1920×1080)          │
  │          Background Color/Image        │
  │   ┌────────────────────────────────┐   │
  │   │                                │   │
  │   │     Video Frame (centered)     │   │
  │   │                                │   │
  │   └────────────────────────────────┘   │
  │                                        │
  └────────────────────────────────────────┘
  ```

  - [ ] Get video dimensions on load
  - [ ] Get original window bounds from recording metadata
  - [ ] **If window was NOT maximized/fullscreen:**
    - [ ] Render video at actual size, centered on canvas
    - [ ] `offsetX = (canvasWidth - videoWidth) / 2`
    - [ ] `offsetY = (canvasHeight - videoHeight) / 2`
  - [ ] **If window WAS maximized/fullscreen:**
    - [ ] Scale down to 90% of canvas size
    - [ ] Add visible padding around edges
    - [ ] `scaledWidth = canvasWidth * 0.9`
    - [ ] `scaledHeight = canvasHeight * 0.9`
    - [ ] Center the scaled video

- [ ] **13.4 Frame-by-Frame Rendering**
  - [ ] On video timeupdate/requestAnimationFrame:
    - [ ] Clear canvas
    - [ ] Draw background (image or solid color)
    - [ ] Draw video frame with calculated offset/scale
    - [ ] (Future: overlay mouse cursor from mouse_events)

- [ ] **13.5 Basic Playback Controls**
  - [ ] Play/Pause button
  - [ ] Seek slider (scrub through video)
  - [ ] Current time / Duration display

- [ ] **13.6 Background Options (Minimal UI)**
  - [ ] Color picker for solid background
  - [ ] OR Image file selector
  - [ ] Preview updates in real-time

- [ ] **13.7 Export Button**
  - [ ] Trigger FFmpeg export with current settings
  - [ ] Show progress indicator
  - [ ] Save to user-chosen location

---

## Phase 14: Native Recording Architecture (Rust) 🚧

- [ ] **14.1 Velocity Crate Updates**
  - [ ] Add `windows-capture` dependency to `velocity/Cargo.toml`
  - [ ] Create `velocity/src/recorder.rs`
  - [ ] Implement `RecorderState` global struct (Mutex)

- [ ] **14.2 Native Recorder Implementation (Rust)**
  - [ ] **`start_recording(config)`**:
    - [ ] Initialize `CaptureControl` / `VideoEncoder`
    - [ ] Disable cursor capture (`CursorCapture::Never`)
    - [ ] Spawn capture loop thread
  - [ ] **`stop_recording()`**:
    - [ ] Signal stop to capture thread
    - [ ] Finalize encoder and close file
    - [ ] Return final file path
  - [ ] **`pause/resume_recording()`**:
    - [ ] Implement frame dropping logic in capture loop

- [ ] **14.3 N-API Exports**
  - [ ] Update `velocity/src/lib.rs` to expose recorder functions
  - [ ] Create TS definitions in `src/electron/services/native-recorder.service.ts`

- [ ] **14.4 Electron Backend Integration**
  - [ ] Refactor `RecorderService.startRecording` to use Native Recorder
  - [ ] Remove `fs.writeStream` and temp file logic (Rust handles IO)
  - [ ] **Keep** `MouseTrackerService` for DB metadata
  - [ ] Handle `stop` and `pause` via Native Recorder

- [ ] **14.5 Frontend Simplification**
  - [ ] Remove `getUserMedia` and `MediaRecorder` from `useScreenRecorder.ts`
  - [ ] Update UI to be a pure remote control for backend
