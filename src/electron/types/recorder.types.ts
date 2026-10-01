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
  /** Native webcam ID from `listWebcamDevices` (defaults to the native default). */
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
  /**
   * The microphone as WASAPI knows it, from `listAudioCaptureDevices`.
   *
   * Separate from `micDeviceId` because that one comes from the browser's
   * `enumerateDevices`, whose ids are salted per origin and mean nothing to the
   * native recorder -- which is why a microphone chosen in the UI used to be
   * ignored and whatever Windows called default got recorded instead.
   */
  nativeMicDeviceId?: string;
  /** Target fps for native singular-clock capture path. */
  targetFps?: 30 | 60;
  /**
   * Linux: ask the portal to remember the source the user picks, so a later
   * recording can reuse it without the picker. Only the Automation API sets
   * this; the recorder's button always asks.
   */
  rememberSource?: boolean;
  /** Linux: the token a remembered recording returned. Used only with `rememberSource`. */
  portalRestoreToken?: string;
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
  /**
   * Linux: the source comes from the system's picker. `choose` until the user
   * picks; `picked` while a pick is held for the next recording.
   */
  portal?: 'choose' | 'picked';
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
  /**
   * True when the named audio went into the recording's own track.
   *
   * The renderer must not also record a sidecar for it -- both would reach the
   * export and the sound would be doubled.
   */
  nativeSystemAudioHandled?: boolean;
  nativeMicrophoneHandled?: boolean;
  /** Linux, with `rememberSource`: the portal's token for the chosen source, if it gave one. */
  portalRestoreToken?: string | null;
  error?: string;
}

/**
 * What the native recorder knows about a file it just wrote.
 *
 * Reported by `Stopper.stop()`. Every field here used to be recovered by
 * demuxing the finished file after capture; the recorder had all of it at
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
