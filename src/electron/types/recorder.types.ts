/**
 * Type definitions for the recording system
 */

/** Current state of a recording session */
export enum RecordingState {
  IDLE = 'IDLE',
  RECORDING = 'RECORDING',
  PAUSED = 'PAUSED',
}

/** Recording quality/format options */
export interface RecordingOptions {
  /** Video bitrate in bps (browser MediaRecorder) */
  videoBitrate?: number;
  /** Audio bitrate in bps */
  audioBitrate?: number;
}

/** Recording configuration provided when starting */
export interface RecordingConfig {
  sourceId: string;
  outputDir: string;
  fileName: string;
  /** File extension without dot (e.g., 'mp4'). Defaults to 'mp4' */
  fileExtension?: 'mp4' | 'mkv';
  /** Whether to record desktop/system audio */
  recordSystemAudio?: boolean;
  /** Whether to record from the camera as a separate file */
  recordCamera?: boolean;
  /** Whether to record microphone audio (embedded into video files) */
  recordMic?: boolean;
  /** Specific camera device ID (defaults to system default) */
  cameraDeviceId?: string;
  /**
   * Where the camera picture comes from. Defaults to a camera on this machine.
   *
   * `'phone'` requires a phone already paired and sending -- see
   * `phone-camera.service.ts`. There is no renderer fallback for it, so a phone
   * that has gone quiet fails the start rather than quietly recording the
   * laptop's own webcam instead.
   */
  cameraSource?: 'local' | 'phone';
  /** Specific microphone device ID (defaults to system default) */
  micDeviceId?: string;
  /** Recording engine mode. Defaults to legacy hybrid capture. */
  nativeCaptureMode?: 'legacy' | 'native-singular-clock';
  /** Target fps for native singular-clock capture path. */
  targetFps?: 30 | 60;
  /** Optional native webcam device id used by velocity v2 path. */
  nativeWebcamDeviceId?: string;
  options?: RecordingOptions;
}

/** Desktop source (screen or window) from desktopCapturer */
export interface DesktopSource {
  id: string;
  name: string;
  thumbnailDataUrl: string;
  isScreen: boolean;
  /** Source origin X in global pixels */
  x?: number;
  /** Source origin Y in global pixels */
  y?: number;
  /** Width in pixels */
  width?: number;
  /** Height in pixels */
  height?: number;
  /** Whether this is the primary monitor */
  isPrimary?: boolean;
}

/** Status of a recording in the database */
export type RecordingStatus = 'recording' | 'paused' | 'completed' | 'failed' | 'orphaned';

/** Recording metadata stored in SQLite */
export interface RecordingMetadata {
  id: string;
  status: RecordingStatus;
  tempPath: string;
  finalPath: string | null;
  outputDir: string;
  fileName: string;
  sourceId: string;
  startedAt: number;
  stoppedAt: number | null;
  windowBounds: {
    width: number;
    height: number;
    isMaximized: boolean;
  } | null;
  /**
   * What the recorder reported when it stopped.
   *
   * Null for recordings made before the recorder started reporting, and for
   * files recovered after a crash -- both fall back to probing the file.
   */
  mediaInfo: RecordingMediaInfo | null;
}

/** State event pushed to renderer */
export interface RecordingStateEvent {
  state: RecordingState;
  recordingId: string | null;
  duration: number;
  bytesWritten: number;
}

/** Result of starting a recording */
export interface StartRecordingResult {
  success: boolean;
  recordingId?: string;
  tempPath?: string;
  /** True when webcam capture is handled fully in native velocity path. */
  nativeWebcamHandled?: boolean;
  error?: string;
}

/**
 * What the native recorder knows about a file it just wrote.
 *
 * Reported by `Stopper.stop()`. Every field here used to be recovered by
 * demuxing the finished file with mediabunny; the recorder had all of it at
 * capture time and was throwing it away.
 */
export interface RecordingMediaInfo {
  outputPath: string;
  /** `screen` or `webcam` -- one recording can produce both. */
  role: 'screen' | 'webcam' | string;
  width: number;
  height: number;
  /** Frames actually handed to the encoder. */
  frames: number;
  durationMs: number;
  /**
   * Measured frames over elapsed capture time.
   *
   * Screen capture is variable-rate: Windows only delivers a frame when
   * something on screen changes, so this is usually far below `configuredFps`
   * and bears no relation to the container's nominal rate. Treat it as an
   * average, not a constant -- for anything frame-exact use `frames` and
   * `durationMs`.
   */
  fps: number;
  /** The rate we asked Windows for. */
  configuredFps: number;
  bitrate: number;
  codec: string;
  /**
   * True only when captured audio bytes actually reached the encoder.
   *
   * The file always carries an AAC track regardless -- windows-capture always
   * registers one -- so track presence proves nothing and this is the only
   * honest answer.
   */
  hasAudio: boolean;
  fileSize: number;
  /** False when the capture produced no frames: a failed recording that still wrote a header. */
  usable: boolean;
}

/** Result of stopping a recording */
export interface StopRecordingResult {
  success: boolean;
  filePath?: string;
  error?: string;
  /**
   * What the recorder wrote, straight from the capture thread. Absent only if
   * the native recorder is too old to report it.
   */
  media?: RecordingMediaInfo;
}
