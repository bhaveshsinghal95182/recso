/**
 * RecorderService
 *
 * Native recording pipeline:
 * - Velocity owns screen/window, webcam, microphone and system-audio capture.
 * - Electron selects devices, controls the session and persists the outputs.
 */

import { createRequire } from 'node:module';

import { app, desktopCapturer, screen } from 'electron';

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import type {
  DesktopSource,
  RecordingConfig,
  RecordingMediaInfo,
  RecordingState,
  RecordingStateEvent,
  StartRecordingResult,
  StopRecordingResult,
} from '../types/recorder.types.js';
import { completeRecording, createRecording, getRecording } from './database.service.js';
import { phoneCameraState } from './phone-camera.service.js';
import { initProjectFolder } from './project-storage.service.js';
import {
  nativeWebcamStartProblem,
  phoneCameraProblem,
  planNativeAudio,
} from './recorder-capture-plan.js';

interface VelocityStopper {
  /**
   * Stops every capture and describes what was written -- one entry per
   * capture, so a v2 recording with the webcam enabled reports two.
   *
   * Returns undefined on a velocity build predating media reporting, which is
   * why every caller treats the result as optional.
   */
  stop(): RecordingMediaInfo[] | undefined;
}

interface VelocityBindings {
  VideoDecoder: new (path: string) => {
    info(): { duration: number };
  };
  listWebcamDevices?(): Array<{
    id: string;
    label: string;
    isDefault: boolean;
  }>;
  startWebcamPreview?(deviceId?: string): VelocityStopper;
  webcamPreviewFrame?(): {
    jpeg: Buffer;
    width: number;
    height: number;
    sequence: number;
  } | null;
  clearWebcamPreviewFrame?(): void;
  listAudioCaptureDevices?(): Array<{
    id: string;
    label: string;
    isDefault: boolean;
  }>;
  listAvailableWindows(): Array<{
    title: string;
    className: string;
    thumbnailDataUrl?: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  startMonitorRecordingV2: (options: {
    outputPath: string;
    bitrate: number;
    includeSystemAudio?: boolean;
    targetFps?: number;
    enableWebcam?: boolean;
    webcamDeviceId?: string;
    webcamSource?: 'local' | 'phone';
    includeMicrophone?: boolean;
    microphoneDeviceId?: string;
  }) => VelocityStopper;
  startWindowRecordingV2: (options: {
    windowTitle: string;
    outputPath: string;
    bitrate: number;
    includeSystemAudio?: boolean;
    targetFps?: number;
    enableWebcam?: boolean;
    webcamDeviceId?: string;
    webcamSource?: 'local' | 'phone';
    includeMicrophone?: boolean;
    microphoneDeviceId?: string;
  }) => VelocityStopper;
}

interface NativeClockOptions {
  targetFps: 30 | 60;
  enableWebcam: boolean;
  webcamDeviceId?: string;
  /** Which camera the native side should open. Omitted means a local one. */
  webcamSource?: 'local' | 'phone';
  /** Capture the microphone natively, into the video's own audio track. */
  includeMicrophone?: boolean;
  /** Which microphone, as an id from `listAudioCaptureDevices`. */
  microphoneDeviceId?: string;
}

interface NativeWebcamCapability {
  supported: boolean;
  selectedDeviceId?: string;
  reason?: string;
}

interface ActiveRecording {
  id: string;
  tempPath: string;
  outputDir: string;
  fileName: string;
  fileExtension: 'mp4' | 'mkv';
  sourceId: string;
  nativeSystemAudioRequested: boolean;
  state: RecordingState;
  startedAt: number;
  wallClockStartMs: number;
  stopper: VelocityStopper;
}

interface ActiveWebcamPreview {
  deviceId?: string;
  stopper: VelocityStopper;
}

interface SourceCaptureBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SourceMeta {
  name: string;
  isScreen: boolean;
  isPrimary: boolean;
  bounds?: SourceCaptureBounds;
}

let activeRecording: ActiveRecording | null = null;
let activeWebcamPreview: ActiveWebcamPreview | null = null;

/**
 * Finalize passes that are currently running, keyed by recording id.
 *
 * Finalizing is slow — waiting on the native capture to flush, then muxing
 * desktop audio into the video — and `final_path` is only written to the
 * database once it completes. Anything that needs a finished recording awaits
 * the entry here instead of reading a half-written row.
 */
const finalizingRecordings = new Map<string, Promise<StopRecordingResult>>();
let velocityBindingsCache: VelocityBindings | null = null;
let sourceMetaById = new Map<string, SourceMeta>();

const START_RECORDING_GENERIC_ERROR = 'Unable to start recording. Refresh sources and try again.';
const START_RECORDING_WINDOW_UNAVAILABLE_ERROR =
  'Selected window is no longer available. Refresh sources and try again.';
const START_RECORDING_ENGINE_UNAVAILABLE_ERROR =
  'Recording engine is unavailable right now. Please restart Recso and try again.';

const require = createRequire(import.meta.url);

function getSafeStartRecordingError(error: unknown, sourceId: string): string {
  const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  const isWindowSource =
    sourceId.startsWith('velocity-window:') || sourceId.startsWith('fallback-window:');

  if (isWindowSource) {
    return START_RECORDING_WINDOW_UNAVAILABLE_ERROR;
  }

  if (
    message.includes('velocity bindings not found') ||
    message.includes('cannot find native binding') ||
    message.includes('failed to load native binding')
  ) {
    return START_RECORDING_ENGINE_UNAVAILABLE_ERROR;
  }

  // velocity's own wording for a capture this platform lacks. Refreshing
  // sources cannot help with that, so say what is actually missing.
  if (message.includes('is not supported on')) {
    return `${(error as Error).message}.`;
  }

  return START_RECORDING_GENERIC_ERROR;
}

function getVelocityBindings(): VelocityBindings {
  if (velocityBindingsCache) {
    return velocityBindingsCache;
  }

  const candidatePaths = [
    path.resolve(process.cwd(), 'velocity', 'index.js'),
    path.resolve(app.getAppPath(), 'velocity', 'index.js'),
    path.resolve(app.getAppPath(), '..', 'velocity', 'index.js'),
    path.resolve(process.resourcesPath, 'velocity', 'index.js'),
    path.resolve(process.resourcesPath, 'app.asar.unpacked', 'velocity', 'index.js'),
  ];

  for (const candidatePath of candidatePaths) {
    if (!fs.existsSync(candidatePath)) {
      continue;
    }

    velocityBindingsCache = require(candidatePath) as VelocityBindings;
    return velocityBindingsCache;
  }

  throw new Error(`Velocity bindings not found. Tried: ${candidatePaths.join(', ')}`);
}

/** Every microphone the native recorder can open. Empty on a build without it. */
export function listNativeAudioCaptureDevices(): Array<{
  id: string;
  label: string;
  isDefault: boolean;
}> {
  try {
    return getVelocityBindings().listAudioCaptureDevices?.() ?? [];
  } catch {
    return [];
  }
}

/** Every webcam the native recorder can open. Empty on a build without it. */
export function listNativeWebcamDevices(): Array<{
  id: string;
  label: string;
  isDefault: boolean;
}> {
  try {
    return getVelocityBindings().listWebcamDevices?.() ?? [];
  } catch {
    return [];
  }
}

export interface NativeWebcamPreviewStartResult {
  success: boolean;
  error?: string;
}

export interface NativeWebcamPreviewFrame {
  jpeg: Buffer;
  width: number;
  height: number;
  sequence: number;
}

/**
 * Open the selected webcam for setup preview.
 *
 * Recording owns the camera once it starts and publishes into the same frame
 * slot, so an active recording is already a successful preview owner.
 */
export function startNativeWebcamPreview(deviceId?: string): NativeWebcamPreviewStartResult {
  if (activeRecording) {
    return { success: true };
  }

  if (activeWebcamPreview && activeWebcamPreview.deviceId === deviceId) {
    return { success: true };
  }

  stopNativeWebcamPreview();

  try {
    const velocity = getVelocityBindings();
    if (typeof velocity.startWebcamPreview !== 'function') {
      return {
        success: false,
        error: 'Native webcam preview is unavailable in this Velocity build.',
      };
    }

    activeWebcamPreview = {
      deviceId,
      stopper: velocity.startWebcamPreview(deviceId),
    };
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start native webcam preview.',
    };
  }
}

/** Release only the setup preview owner; this never stops an active recording. */
export function stopNativeWebcamPreview(): void {
  const current = activeWebcamPreview;
  activeWebcamPreview = null;

  if (current) {
    try {
      current.stopper.stop();
    } catch (error) {
      console.warn('[RecorderService] Failed to stop native webcam preview:', error);
    }
  }

  if (!activeRecording) {
    try {
      getVelocityBindings().clearWebcamPreviewFrame?.();
    } catch {
      // The preview is already stopped. A stale thumbnail is preferable to
      // turning teardown into an application error on an older native build.
    }
  }
}

/** The newest small JPEG emitted by whichever native owner currently has the camera. */
export function nativeWebcamPreviewFrame(): NativeWebcamPreviewFrame | null {
  try {
    return getVelocityBindings().webcamPreviewFrame?.() ?? null;
  } catch {
    return null;
  }
}

function startVelocityMonitorRecording(
  velocity: VelocityBindings,
  outputPath: string,
  bitrate: number,
  includeSystemAudio: boolean,
  nativeClockOptions: NativeClockOptions,
): VelocityStopper {
  return velocity.startMonitorRecordingV2({
    outputPath,
    bitrate,
    includeSystemAudio,
    targetFps: nativeClockOptions.targetFps,
    enableWebcam: nativeClockOptions.enableWebcam,
    webcamDeviceId: nativeClockOptions.webcamDeviceId,
    webcamSource: nativeClockOptions.webcamSource,
    includeMicrophone: nativeClockOptions.includeMicrophone,
    microphoneDeviceId: nativeClockOptions.microphoneDeviceId,
  });
}

function startVelocityWindowRecording(
  velocity: VelocityBindings,
  windowTitle: string,
  outputPath: string,
  bitrate: number,
  includeSystemAudio: boolean,
  nativeClockOptions: NativeClockOptions,
): VelocityStopper {
  return velocity.startWindowRecordingV2({
    windowTitle,
    outputPath,
    bitrate,
    includeSystemAudio,
    targetFps: nativeClockOptions.targetFps,
    enableWebcam: nativeClockOptions.enableWebcam,
    webcamDeviceId: nativeClockOptions.webcamDeviceId,
    webcamSource: nativeClockOptions.webcamSource,
    includeMicrophone: nativeClockOptions.includeMicrophone,
    microphoneDeviceId: nativeClockOptions.microphoneDeviceId,
  });
}

function resolveNativeWebcamCapability(
  velocity: VelocityBindings,
  requestedDeviceId?: string,
): NativeWebcamCapability {
  if (typeof velocity.listWebcamDevices !== 'function') {
    return {
      supported: false,
      reason: 'native webcam device enumeration is unavailable in this velocity build',
    };
  }

  try {
    const devices = velocity.listWebcamDevices();
    if (!Array.isArray(devices) || devices.length === 0) {
      return {
        supported: false,
        reason: 'no native webcam devices were reported by velocity',
      };
    }

    if (requestedDeviceId) {
      const requested = devices.find((device) => device.id === requestedDeviceId);
      if (requested) {
        return { supported: true, selectedDeviceId: requested.id };
      }

      const defaultDevice = devices.find((device) => device.isDefault) ?? devices[0];
      return {
        supported: true,
        selectedDeviceId: defaultDevice?.id,
        reason: `requested webcam device '${requestedDeviceId}' was not found; using native default webcam '${defaultDevice?.id || 'unknown'}'`,
      };
    }

    const defaultDevice = devices.find((device) => device.isDefault) ?? devices[0];
    return { supported: true, selectedDeviceId: defaultDevice?.id };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : 'native webcam capability check failed',
    };
  }
}

function scaleDisplayBounds(
  bounds: { x: number; y: number; width: number; height: number },
  scaleFactor: number | undefined,
): SourceCaptureBounds {
  const scale =
    Number.isFinite(scaleFactor) && (scaleFactor as number) > 0 ? (scaleFactor as number) : 1;

  return {
    x: Math.round(bounds.x * scale),
    y: Math.round(bounds.y * scale),
    width: Math.max(1, Math.round(bounds.width * scale)),
    height: Math.max(1, Math.round(bounds.height * scale)),
  };
}

function resolveBoundsFromSource(source: DesktopSource): SourceCaptureBounds | undefined {
  if (
    !Number.isFinite(source.x) ||
    !Number.isFinite(source.y) ||
    !Number.isFinite(source.width) ||
    !Number.isFinite(source.height)
  ) {
    return undefined;
  }

  const width = Math.round(source.width as number);
  const height = Math.round(source.height as number);
  if (width <= 0 || height <= 0) {
    return undefined;
  }

  return {
    x: Math.round(source.x as number),
    y: Math.round(source.y as number),
    width,
    height,
  };
}

/**
 * Get available desktop sources (screens and windows).
 */
export async function getSources(): Promise<DesktopSource[]> {
  if (process.platform === 'linux') {
    return getPortalSources();
  }

  const isPackagedWindows = process.platform === 'win32' && app.isPackaged;
  const attemptCount = isPackagedWindows ? 3 : 1;
  const displayById = new Map(
    screen.getAllDisplays().map((display) => [String(display.id), display]),
  );
  const primaryDisplayId = screen.getPrimaryDisplay().id;
  const sourceById = new Map<string, DesktopSource>();

  for (let attempt = 1; attempt <= attemptCount; attempt++) {
    const batch = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });

    for (const source of batch) {
      const displayId = source.display_id ? String(source.display_id) : null;
      const matchedDisplay = displayId ? displayById.get(displayId) : undefined;
      const scaledBounds = matchedDisplay
        ? scaleDisplayBounds(matchedDisplay.bounds, matchedDisplay.scaleFactor)
        : undefined;

      if (matchedDisplay && matchedDisplay.id !== primaryDisplayId) {
        continue;
      }

      sourceById.set(source.id, {
        id: source.id,
        name: source.name,
        thumbnailDataUrl: source.thumbnail.toDataURL(),
        isScreen: true,
        x: scaledBounds?.x,
        y: scaledBounds?.y,
        width: scaledBounds?.width,
        height: scaledBounds?.height,
        isPrimary: matchedDisplay ? matchedDisplay.id === primaryDisplayId : undefined,
      });
    }

    if (isPackagedWindows) {
      const screens = Array.from(sourceById.values()).filter((s) => s.isScreen).length;
      const windows = sourceById.size - screens;
      console.log(
        `[RecorderService] getSources attempt ${attempt}/${attemptCount}: total=${sourceById.size}, screens=${screens}, windows=${windows}`,
      );

      if (attempt < attemptCount) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  try {
    const velocity = getVelocityBindings();
    const windows = velocity.listAvailableWindows();

    windows.forEach((windowInfo, index) => {
      const id = `velocity-window:${index}`;
      sourceById.set(id, {
        id,
        name: windowInfo.title,
        thumbnailDataUrl: windowInfo.thumbnailDataUrl || '',
        isScreen: false,
        x: windowInfo.x,
        y: windowInfo.y,
        width: windowInfo.width,
        height: windowInfo.height,
      });
    });
  } catch (error) {
    console.warn(
      '[RecorderService] Failed to list windows via velocity, using Electron fallback:',
      error,
    );

    const fallbackWindows = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });

    fallbackWindows.forEach((source, index) => {
      const id = `fallback-window:${index}`;
      sourceById.set(id, {
        id,
        name: source.name,
        thumbnailDataUrl: source.thumbnail.toDataURL(),
        isScreen: false,
      });
    });
  }

  const normalizedSources = Array.from(sourceById.values());
  sourceMetaById = new Map(
    normalizedSources.map((source) => [
      source.id,
      {
        name: source.name,
        isScreen: source.isScreen,
        isPrimary: Boolean(source.isPrimary),
        bounds: resolveBoundsFromSource(source),
      },
    ]),
  );

  return normalizedSources;
}

/**
 * The one source Linux offers: whatever the system picker returns.
 *
 * On Wayland an app cannot list or look at other windows. Screen capture goes
 * through the xdg-desktop-portal, whose own dialog is the picker -- and
 * `desktopCapturer.getSources` would open that dialog just to fill this list.
 * So the list holds a single entry, and velocity opens the portal when the
 * recording starts, where the user picks a screen or a window.
 */
function getPortalSources(): DesktopSource[] {
  const primaryDisplay = screen.getPrimaryDisplay();
  const bounds = scaleDisplayBounds(primaryDisplay.bounds, primaryDisplay.scaleFactor);
  const source: DesktopSource = {
    id: 'screen:portal',
    name: 'Screen or window (chosen when recording starts)',
    thumbnailDataUrl: '',
    isScreen: true,
    isPrimary: true,
    ...bounds,
  };

  sourceMetaById = new Map([
    [source.id, { name: source.name, isScreen: true, isPrimary: true, bounds }],
  ]);

  return [source];
}

export function resolveMouseTrackingBounds(sourceId: string): SourceCaptureBounds | undefined {
  const sourceMeta = sourceMetaById.get(sourceId);
  if (sourceMeta?.bounds) {
    return sourceMeta.bounds;
  }

  const likelyScreenSource =
    sourceMeta?.isScreen !== undefined
      ? sourceMeta.isScreen
      : sourceId.startsWith('screen:') || sourceId === 'screen';

  if (likelyScreenSource) {
    const primaryDisplay = screen.getPrimaryDisplay();
    return scaleDisplayBounds(primaryDisplay.bounds, primaryDisplay.scaleFactor);
  }

  // Fallback keeps cursor tracking functional on older native builds that do not expose window bounds yet.
  const primaryDisplay = screen.getPrimaryDisplay();
  return scaleDisplayBounds(primaryDisplay.bounds, primaryDisplay.scaleFactor);
}

function ensureTempDir(): string {
  const tempDir = path.join(app.getPath('temp'), 'recso');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  return tempDir;
}

function inferNativeCameraSidecarPath(videoPath: string): string {
  const parsed = path.parse(videoPath);
  return path.join(parsed.dir, `${parsed.name}_camera${parsed.ext || '.mp4'}`);
}

const NATIVE_FINALIZE_POLL_MS = 250;
const NATIVE_FINALIZE_STABLE_SAMPLES = 2;
const NATIVE_FINALIZE_TIMEOUT_MS = 120_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pick the screen capture out of what the recorder reported.
 *
 * A v2 recording with the webcam enabled reports two entries. Match on the
 * output path rather than trusting order, and fall back to the role so an
 * older build that only reports one still works.
 */
/**
 * The recorder reports the temp path it wrote to; by the time anyone consumes
 * this, the file has been moved into the recording folder.
 */
function mediaAtFinalPath(
  media: RecordingMediaInfo | null,
  finalPath: string,
): RecordingMediaInfo | undefined {
  if (!media) {
    return undefined;
  }
  return { ...media, outputPath: finalPath };
}

function findScreenMedia(
  reported: RecordingMediaInfo[] | undefined,
  tempPath: string,
): RecordingMediaInfo | null {
  if (!reported?.length) {
    return null;
  }

  const normalize = (value: string) => path.resolve(value).toLowerCase();
  const wanted = normalize(tempPath);

  return (
    reported.find((info) => normalize(info.outputPath) === wanted) ??
    reported.find((info) => info.role === 'screen') ??
    null
  );
}

async function hasReadableVideoTrack(filePath: string): Promise<boolean> {
  try {
    return new (getVelocityBindings().VideoDecoder)(filePath).info().duration > 0;
  } catch {
    return false;
  }
}

/**
 * Waits until the native capture file is actually finished being written.
 *
 * `Stopper.stop()` gives up waiting on the capture thread after a few seconds, and the encoder's
 * finalization work scales with the length of the recording — so on longer recordings it can still
 * be writing when stop() returns. Moving the file at that point produces a truncated, unplayable
 * recording, so the file has to prove it is complete: a size that stopped changing *and* a video
 * track that can be read back, which is only true once the trailing metadata has been written.
 */
async function waitForNativeRecordingFile(filePath: string): Promise<boolean> {
  const startedAtMs = Date.now();
  let lastSize = -1;
  let stableSamples = 0;

  while (Date.now() - startedAtMs < NATIVE_FINALIZE_TIMEOUT_MS) {
    let size = -1;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      size = -1;
    }

    if (size > 0 && size === lastSize) {
      stableSamples += 1;

      if (
        stableSamples >= NATIVE_FINALIZE_STABLE_SAMPLES &&
        (await hasReadableVideoTrack(filePath))
      ) {
        return true;
      }
    } else {
      stableSamples = 0;
    }

    lastSize = size;
    await delay(NATIVE_FINALIZE_POLL_MS);
  }

  return false;
}

/**
 * Start a new recording session.
 *
 * Velocity owns screen/window video, webcam, microphone and system audio.
 * The renderer only selects native device ids and controls the session.
 */
export function startRecording(config: RecordingConfig): StartRecordingResult {
  if (activeRecording) {
    return { success: false, error: 'A recording is already in progress' };
  }

  // Release the setup owner before recording opens the same physical camera.
  stopNativeWebcamPreview();

  let stopper: VelocityStopper | null = null;

  try {
    const velocity = getVelocityBindings();
    const recordingId = randomUUID();
    if (config.fileExtension === 'mkv') {
      console.warn(
        '[RecorderService] MKV recording is temporarily disabled for native capture; using MP4 to avoid corruption.',
      );
    }
    const fileExt: 'mp4' = 'mp4';
    const bitrate = config.options?.videoBitrate || 8_000_000;
    const tempDir = ensureTempDir();
    const tempPath = path.join(tempDir, `rec_vel_${recordingId}.${fileExt}`);

    const selectedSourceId = config.sourceId;
    const selectedSourceMeta = sourceMetaById.get(selectedSourceId);
    const isScreenSource = selectedSourceMeta
      ? selectedSourceMeta.isScreen
      : selectedSourceId.startsWith('screen:') || selectedSourceId === 'screen';
    const usePhoneCamera = config.cameraSource === 'phone';

    // Checked before anything else, and outside the native-path branch below.
    // A phone that is not sending has to fail here rather than fall through to
    // a take with no camera track in it. A selected camera is part of the native
    // recording contract, so there is no screen-only retry downstream.
    const phoneProblem = phoneCameraProblem(config, phoneCameraState()?.live ?? false);
    if (phoneProblem) {
      return { success: false, error: phoneProblem };
    }

    // Audio goes into the video's own track when the native path is running, so
    // there is no second clock to reconcile afterwards. See `planNativeAudio`.
    const nativeAudio = planNativeAudio({
      recordSystemAudio: config.recordSystemAudio,
      recordMic: config.recordMic,
      platform: process.platform,
    });
    const useNativeSystemAudio = nativeAudio.systemAudio;

    if (config.recordSystemAudio && !useNativeSystemAudio) {
      console.log(
        '[RecorderService] Native system audio unavailable; using desktop audio sidecar + mux fallback.',
      );
    }

    const nativeClockOptions: NativeClockOptions = {
      includeMicrophone: nativeAudio.microphone,
      // Only meaningful to the native path: a browser device id would not
      // resolve to a WASAPI endpoint.
      microphoneDeviceId: config.nativeMicDeviceId,
      targetFps: config.targetFps === 30 ? 30 : 60,
      enableWebcam: Boolean(config.recordCamera),
      webcamDeviceId: config.cameraDeviceId,
      webcamSource: usePhoneCamera ? 'phone' : 'local',
    };
    let useNativeWebcam = false;
    let nativeWebcamDeviceId = nativeClockOptions.webcamDeviceId;

    if (nativeClockOptions.enableWebcam) {
      if (usePhoneCamera) {
        // Liveness was already checked above. Skipping the local capability
        // probe on purpose: it asks what cameras this machine has, which says
        // nothing about a phone and would reject one on a laptop with no
        // built-in webcam.
        useNativeWebcam = true;
        nativeWebcamDeviceId = undefined;
      } else {
        const webcamCapability = resolveNativeWebcamCapability(
          velocity,
          nativeClockOptions.webcamDeviceId,
        );

        if (webcamCapability.supported) {
          useNativeWebcam = true;
          nativeWebcamDeviceId = webcamCapability.selectedDeviceId || nativeWebcamDeviceId;
          if (webcamCapability.reason) {
            console.warn(
              `[RecorderService] Native webcam selection note: ${webcamCapability.reason}.`,
            );
          }
        } else {
          return {
            success: false,
            error: `Native webcam capture is unavailable: ${webcamCapability.reason || 'unknown reason'}.`,
          };
        }
      }
    }

    const effectiveNativeClockOptions: NativeClockOptions = {
      ...nativeClockOptions,
      enableWebcam: useNativeWebcam,
      webcamDeviceId: useNativeWebcam ? nativeWebcamDeviceId : undefined,
    };

    {
      console.log('[RecorderService] Native singular-clock capture mode enabled', {
        targetFps: nativeClockOptions.targetFps,
        webcamEnabled: useNativeWebcam,
        webcamRequested: nativeClockOptions.enableWebcam,
        // Named because a phone that records nothing looks identical to one
        // that was never selected, and this is the line that tells them apart.
        webcamSource: nativeClockOptions.webcamSource,
      });
    }

    if (isScreenSource) {
      if (selectedSourceMeta && !selectedSourceMeta.isPrimary) {
        return {
          success: false,
          error:
            'Velocity currently records only the primary display. Please choose Primary Display.',
        };
      }

      try {
        stopper = startVelocityMonitorRecording(
          velocity,
          tempPath,
          bitrate,
          useNativeSystemAudio,
          effectiveNativeClockOptions,
        );
      } catch (error) {
        const webcamProblem = useNativeWebcam
          ? nativeWebcamStartProblem(error, usePhoneCamera)
          : null;
        if (!webcamProblem) {
          throw error;
        }

        return { success: false, error: webcamProblem };
      }
    } else {
      const windowTitle = selectedSourceMeta?.name;
      if (!windowTitle) {
        return {
          success: false,
          error: 'Selected window is no longer available. Refresh sources and try again.',
        };
      }

      try {
        stopper = startVelocityWindowRecording(
          velocity,
          windowTitle,
          tempPath,
          bitrate,
          useNativeSystemAudio,
          effectiveNativeClockOptions,
        );
      } catch (error) {
        const webcamProblem = useNativeWebcam
          ? nativeWebcamStartProblem(error, usePhoneCamera)
          : null;
        if (!webcamProblem) {
          throw error;
        }

        return { success: false, error: webcamProblem };
      }
    }

    createRecording({
      id: recordingId,
      status: 'recording',
      tempPath,
      finalPath: null,
      // Not knowable until the recorder stops and reports.
      mediaInfo: null,
      outputDir: config.outputDir,
      fileName: config.fileName,
      sourceId: config.sourceId,
      startedAt: Date.now(),
      windowBounds: null,
    });

    activeRecording = {
      id: recordingId,
      tempPath,
      outputDir: config.outputDir,
      fileName: config.fileName,
      fileExtension: fileExt,
      sourceId: config.sourceId,
      nativeSystemAudioRequested: useNativeSystemAudio,
      state: 'RECORDING' as RecordingState,
      startedAt: Date.now(),
      wallClockStartMs: Date.now(),
      stopper,
    };

    console.log('[RecorderService] Started recording:', recordingId);

    return {
      success: true,
      recordingId,
      tempPath,
      nativeWebcamHandled: useNativeWebcam,
      nativeSystemAudioHandled: nativeAudio.systemAudio,
      nativeMicrophoneHandled: nativeAudio.microphone,
    };
  } catch (error) {
    if (stopper) {
      try {
        stopper.stop();
      } catch {
        // ignored
      }
    }

    const safeError = getSafeStartRecordingError(error, config.sourceId);

    console.error('[RecorderService] Failed to start native recording:', error);
    return {
      success: false,
      error: safeError,
    };
  }
}

/**
 * Stop active recording and persist outputs.
 *
 * Never call this directly — go through `stopRecording`, which makes the pass
 * shareable so concurrent callers join it rather than starting a second one.
 */

async function finalizeRecording(recordingId: string): Promise<StopRecordingResult> {
  if (!activeRecording || activeRecording.id !== recordingId) {
    return { success: false, error: 'No active recording with this ID' };
  }

  const currentRecording = activeRecording;

  try {
    // The recorder describes what it wrote. This is the only place that
    // information exists without reopening the file, so hold on to it: it
    // answers duration, geometry, frame count, real fps and whether the audio
    // track carries anything, all of which used to cost a demux pass.
    const reported = currentRecording.stopper.stop();
    const screenMedia = findScreenMedia(reported, currentRecording.tempPath);

    if (screenMedia) {
      // `frames` counts what Windows Graphics Capture handed over, and it only
      // hands over a frame when the screen changed -- so a low rate on a mostly
      // still desktop is the API working, not the capture struggling. The file
      // is written at `configuredFps` regardless, holding the last frame across
      // the gaps. Saying "measured (asked for 60)" read like a shortfall and
      // sent more than one person looking for a bug that was not there.
      console.log(
        `[RecorderService] Recorder reported ${screenMedia.frames} frames, ` +
          `${screenMedia.width}x${screenMedia.height}, ` +
          `${(screenMedia.durationMs / 1000).toFixed(2)}s, ` +
          `${screenMedia.fps.toFixed(2)} fps delivered on change ` +
          `(file is ${screenMedia.configuredFps}fps), ` +
          `audio=${screenMedia.hasAudio}`,
      );
    }

    // Wait for the native capture loop to flush and close its output file before touching it.
    const finalizeStartedAtMs = Date.now();
    const nativeFileReady = await waitForNativeRecordingFile(currentRecording.tempPath);
    console.log(
      `[RecorderService] Native capture finalize took ${Date.now() - finalizeStartedAtMs}ms (ready=${nativeFileReady})`,
    );

    if (!nativeFileReady) {
      // Leaving the temp file and the incomplete database row in place lets the recovery flow
      // offer this recording on the next launch instead of shipping a corrupt file as a success.
      console.error(
        '[RecorderService] Native capture file never finished writing:',
        currentRecording.tempPath,
      );
      activeRecording = null;

      return {
        success: false,
        error:
          'The recording did not finish writing to disk. It has been kept for recovery — reopen the app to restore it.',
      };
    }

    if (!fs.existsSync(currentRecording.outputDir)) {
      fs.mkdirSync(currentRecording.outputDir, { recursive: true });
    }

    let folderName = currentRecording.fileName;
    let recordingFolderPath = path.join(currentRecording.outputDir, folderName);
    let counter = 1;

    while (fs.existsSync(recordingFolderPath)) {
      folderName = `${currentRecording.fileName}_${counter}`;
      recordingFolderPath = path.join(currentRecording.outputDir, folderName);
      counter++;
    }

    fs.mkdirSync(recordingFolderPath, { recursive: true });
    initProjectFolder(recordingFolderPath);

    const finalScreenPath = path.join(
      recordingFolderPath,
      `${folderName}.${currentRecording.fileExtension}`,
    );

    const nativeCameraTempPath = inferNativeCameraSidecarPath(currentRecording.tempPath);
    const nativeCameraFinalPath = inferNativeCameraSidecarPath(finalScreenPath);

    fs.renameSync(currentRecording.tempPath, finalScreenPath);

    if (fs.existsSync(nativeCameraTempPath)) {
      try {
        const nativeCameraStats = fs.statSync(nativeCameraTempPath);
        if (nativeCameraStats.size > 0) {
          if (fs.existsSync(nativeCameraFinalPath)) {
            fs.unlinkSync(nativeCameraFinalPath);
          }
          fs.renameSync(nativeCameraTempPath, nativeCameraFinalPath);
          console.log('[RecorderService] Saved native webcam sidecar:', nativeCameraFinalPath);
        } else {
          fs.unlinkSync(nativeCameraTempPath);
        }
      } catch (error) {
        console.warn('[RecorderService] Failed to finalize native webcam sidecar:', error);
      }
    }

    completeRecording(recordingId, finalScreenPath, mediaAtFinalPath(screenMedia, finalScreenPath));
    activeRecording = null;

    return {
      success: true,
      filePath: finalScreenPath,
      media: mediaAtFinalPath(screenMedia, finalScreenPath),
    };
  } catch (error) {
    console.error('[RecorderService] Failed to stop recording:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Stop the active recording and wait for its outputs to be written.
 *
 * Calling this while a finalize is already running returns that same pass, so
 * a second stop trigger resolves when the real work finishes instead of
 * reporting a success the recording has not reached yet.
 */
export function stopRecording(recordingId: string): Promise<StopRecordingResult> {
  const inFlight = finalizingRecordings.get(recordingId);
  if (inFlight) {
    return inFlight;
  }

  const pass = finalizeRecording(recordingId).finally(() => {
    finalizingRecordings.delete(recordingId);
  });

  finalizingRecordings.set(recordingId, pass);
  return pass;
}

/**
 * Resolve once `recordingId` is no longer being finalized.
 *
 * Returns immediately when nothing is in flight — either the recording already
 * finished or it was never being finalized here (say, after a restart). Callers
 * still have to check what they actually need afterwards; this only guarantees
 * they are not reading the database mid-write.
 */
export async function whenFinalized(recordingId: string): Promise<void> {
  const inFlight = finalizingRecordings.get(recordingId);
  if (!inFlight) {
    return;
  }

  // Worth a line: reaching here means something asked for this recording while
  // it was still being written, which is the race this registry exists to
  // absorb. Silence would make it look like it never happened.
  const waitStartedAtMs = Date.now();
  console.log('[RecorderService] Waiting on in-flight finalize for:', recordingId);

  // A failed finalize is still a finished one. Whatever went wrong is reported
  // to whoever called stopRecording; here we only care that writing is over.
  await inFlight.catch(() => undefined);

  console.log(
    `[RecorderService] Finalize wait for ${recordingId} took ${Date.now() - waitStartedAtMs}ms`,
  );
}

/**
 * Pause the active recording. Native capture currently has no pause operation.
 */
export function pauseRecording(recordingId: string): boolean {
  if (!activeRecording || activeRecording.id !== recordingId) {
    return false;
  }

  console.warn('[RecorderService] Pause is not supported for native velocity capture; continuing.');
  return false;
}

/**
 * Resume a paused recording.
 */
export function resumeRecording(recordingId: string): boolean {
  if (!activeRecording || activeRecording.id !== recordingId) {
    return false;
  }

  console.warn(
    '[RecorderService] Resume is not supported for native velocity capture; continuing.',
  );
  return false;
}

/**
 * Get current recording state.
 */
export function getState(): RecordingStateEvent {
  if (!activeRecording) {
    return {
      state: 'IDLE' as RecordingState,
      recordingId: null,
      duration: 0,
      bytesWritten: 0,
    };
  }

  const duration = Date.now() - activeRecording.startedAt;

  let bytesWritten = 0;
  try {
    const stats = fs.statSync(activeRecording.tempPath);
    bytesWritten += stats.size;
  } catch {
    // ignore
  }

  return {
    state: activeRecording.state,
    recordingId: activeRecording.id,
    duration,
    bytesWritten,
  };
}

/**
 * Get temp path for crash recovery.
 */
export function getTempPath(recordingId: string): string | null {
  const recording = getRecording(recordingId);
  return recording?.tempPath || null;
}
