/**
 * RecorderService
 *
 * Hybrid recording pipeline:
 * - Velocity native capture for screen/window video
 * - Electron-managed auxiliary streams (camera / mic / desktop-audio)
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
  listWebcamDevices?(): Array<{
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
  startMonitorRecording(
    outputPath: string,
    bitrate: number,
    includeSystemAudio?: boolean,
  ): VelocityStopper;
  startWindowRecording(
    windowTitle: string,
    outputPath: string,
    bitrate: number,
    includeSystemAudio?: boolean,
  ): VelocityStopper;
  startMonitorRecordingV2?: (options: {
    outputPath: string;
    bitrate: number;
    includeSystemAudio?: boolean;
    targetFps?: number;
    enableWebcam?: boolean;
    webcamDeviceId?: string;
    webcamSource?: 'local' | 'phone';
  }) => VelocityStopper;
  startWindowRecordingV2?: (options: {
    windowTitle: string;
    outputPath: string;
    bitrate: number;
    includeSystemAudio?: boolean;
    targetFps?: number;
    enableWebcam?: boolean;
    webcamDeviceId?: string;
    webcamSource?: 'local' | 'phone';
  }) => VelocityStopper;
}

interface NativeClockOptions {
  useSingularClock: boolean;
  targetFps: 30 | 60;
  enableWebcam: boolean;
  webcamDeviceId?: string;
  /** Which camera the native side should open. Omitted means a local one. */
  webcamSource?: 'local' | 'phone';
}

interface NativeWebcamCapability {
  supported: boolean;
  selectedDeviceId?: string;
  reason?: string;
}

interface AuxStreamState {
  streamId: string;
  tempPath: string;
  fd: number;
  bytesWritten: number;
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
  auxStreams: Record<string, AuxStreamState>;
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

function startVelocityMonitorRecording(
  velocity: VelocityBindings,
  outputPath: string,
  bitrate: number,
  includeSystemAudio: boolean,
  nativeClockOptions?: NativeClockOptions,
): VelocityStopper {
  if (
    nativeClockOptions?.useSingularClock &&
    typeof velocity.startMonitorRecordingV2 === 'function'
  ) {
    return velocity.startMonitorRecordingV2({
      outputPath,
      bitrate,
      includeSystemAudio,
      targetFps: nativeClockOptions.targetFps,
      enableWebcam: nativeClockOptions.enableWebcam,
      webcamDeviceId: nativeClockOptions.webcamDeviceId,
      webcamSource: nativeClockOptions.webcamSource,
    });
  }

  try {
    return velocity.startMonitorRecording(outputPath, bitrate, includeSystemAudio);
  } catch {
    // Backward compatibility for older prebuilt binaries with the two-argument signature.
    return velocity.startMonitorRecording(outputPath, bitrate);
  }
}

function startVelocityWindowRecording(
  velocity: VelocityBindings,
  windowTitle: string,
  outputPath: string,
  bitrate: number,
  includeSystemAudio: boolean,
  nativeClockOptions?: NativeClockOptions,
): VelocityStopper {
  if (
    nativeClockOptions?.useSingularClock &&
    typeof velocity.startWindowRecordingV2 === 'function'
  ) {
    return velocity.startWindowRecordingV2({
      windowTitle,
      outputPath,
      bitrate,
      includeSystemAudio,
      targetFps: nativeClockOptions.targetFps,
      enableWebcam: nativeClockOptions.enableWebcam,
      webcamDeviceId: nativeClockOptions.webcamDeviceId,
      webcamSource: nativeClockOptions.webcamSource,
    });
  }

  try {
    return velocity.startWindowRecording(windowTitle, outputPath, bitrate, includeSystemAudio);
  } catch {
    // Backward compatibility for older prebuilt binaries with the two-argument signature.
    return velocity.startWindowRecording(windowTitle, outputPath, bitrate);
  }
}

function shouldUseNativeSingularClock(config: RecordingConfig): boolean {
  if (config.nativeCaptureMode === 'native-singular-clock') {
    return true;
  }

  return process.env.RECSO_NATIVE_SINGULAR_CLOCK === '1';
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

function openAuxStream(
  tempDir: string,
  recordingId: string,
  streamId: string,
  ext: string,
): AuxStreamState {
  const tempPath = path.join(tempDir, `rec_aux_${recordingId}_${streamId}.${ext}`);
  const fd = fs.openSync(tempPath, 'w');
  return {
    streamId,
    tempPath,
    fd,
    bytesWritten: 0,
  };
}

function closeAuxStreams(auxStreams: Record<string, AuxStreamState>): void {
  Object.values(auxStreams).forEach((stream) => {
    try {
      fs.closeSync(stream.fd);
    } catch {
      // ignored
    }
  });
}

function cleanupAuxTempFiles(auxStreams: Record<string, AuxStreamState>): void {
  Object.values(auxStreams).forEach((stream) => {
    try {
      if (fs.existsSync(stream.tempPath)) {
        fs.unlinkSync(stream.tempPath);
      }
    } catch {
      // ignored
    }
  });
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
  const { ALL_FORMATS, FilePathSource, Input } = await import('mediabunny');

  const input = new Input({
    source: new FilePathSource(filePath),
    formats: ALL_FORMATS,
  });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      return false;
    }

    return (await videoTrack.computeDuration()) > 0;
  } catch {
    return false;
  } finally {
    input.dispose();
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
 * Reports whether a file carries *usable* audio.
 *
 * The presence of an audio track is not enough: windows-capture (the crate behind velocity) always
 * registers an audio stream on its encoder, even when audio capture is disabled, so every
 * video-only native recording contains an AAC track with zero samples. Treating that stub as real
 * audio would make the caller throw away the desktop-audio sidecar and ship a silent recording.
 */
async function hasPrimaryAudioTrack(filePath: string): Promise<boolean> {
  const { ALL_FORMATS, FilePathSource, Input } = await import('mediabunny');

  const input = new Input({
    source: new FilePathSource(filePath),
    formats: ALL_FORMATS,
  });

  try {
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) {
      return false;
    }

    return (await audioTrack.computeDuration()) > 0;
  } catch {
    return false;
  } finally {
    input.dispose();
  }
}

async function muxDesktopAudioIntoVideo(
  videoPath: string,
  audioPath: string,
  fileExtension: 'mp4' | 'mkv',
): Promise<boolean> {
  const ext = `.${fileExtension}`;
  const videoDir = path.dirname(videoPath);
  const videoBaseName = path.basename(videoPath, ext);
  const muxedOutputPath = path.join(videoDir, `${videoBaseName}_muxed${ext}`);

  const {
    ALL_FORMATS,
    EncodedAudioPacketSource,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    FilePathSource,
    FilePathTarget,
    Input,
    MkvOutputFormat,
    Mp4OutputFormat,
    Output,
  } = await import('mediabunny');

  const videoInput = new Input({
    source: new FilePathSource(videoPath),
    formats: ALL_FORMATS,
  });

  const audioInput = new Input({
    source: new FilePathSource(audioPath),
    formats: ALL_FORMATS,
  });

  let output: any = null;

  try {
    const videoTrack = await videoInput.getPrimaryVideoTrack();
    const audioTrack = await audioInput.getPrimaryAudioTrack();

    if (!videoTrack || !audioTrack || !videoTrack.codec || !audioTrack.codec) {
      console.warn('[RecorderService] Unable to mux desktop audio: missing compatible tracks.');
      return false;
    }

    const format =
      fileExtension === 'mkv'
        ? new MkvOutputFormat()
        : new Mp4OutputFormat({ fastStart: 'in-memory' });

    output = new Output({
      format,
      target: new FilePathTarget(muxedOutputPath),
    });

    const videoSource = new EncodedVideoPacketSource(videoTrack.codec);
    output.addVideoTrack(videoSource);

    const audioSource = new EncodedAudioPacketSource(audioTrack.codec);
    output.addAudioTrack(audioSource);

    const videoSink = new EncodedPacketSink(videoTrack);
    const audioSink = new EncodedPacketSink(audioTrack);

    const videoDecoderConfig = await videoTrack.getDecoderConfig();
    const audioDecoderConfig = await audioTrack.getDecoderConfig();
    const videoMeta = videoDecoderConfig ? { decoderConfig: videoDecoderConfig } : undefined;
    const audioMeta = audioDecoderConfig ? { decoderConfig: audioDecoderConfig } : undefined;

    const videoStartTimestamp = await videoTrack.getFirstTimestamp();
    const audioStartTimestamp = await audioTrack.getFirstTimestamp();

    // Base offset calculation from file timestamps. Mediabunny reports timestamps in seconds.
    let audioTimestampOffset = videoStartTimestamp - audioStartTimestamp;

    // Detect and compensate for audio initialization delay.
    // The audio stream opens after native video capture is already running, but both are stopped
    // together — so the device warm-up shows up as audio being shorter than the video, and the
    // audio has to be pushed later by that difference to line up with the picture.
    const videoDuration = await videoInput.computeDuration();
    const audioDuration = await audioInput.computeDuration();

    if (Number.isFinite(videoDuration) && Number.isFinite(audioDuration) && videoDuration > 0) {
      const audioInitDelaySeconds = videoDuration - audioDuration;

      // Typical audio device init is well under a second; anything larger is not a warm-up delay
      // (e.g. a truncated sidecar) and is left uncorrected.
      if (audioInitDelaySeconds > 0.05 && audioInitDelaySeconds <= 3) {
        audioTimestampOffset += audioInitDelaySeconds;

        console.log(
          '[RecorderService] Audio sync fix: detected',
          (audioInitDelaySeconds * 1000).toFixed(0),
          'ms init delay, adjusting offset from',
          (videoStartTimestamp - audioStartTimestamp).toFixed(3),
          's to',
          audioTimestampOffset.toFixed(3),
          's',
        );
      }
    }

    await output.start();

    let videoPacket = await videoSink.getFirstPacket();
    let audioPacket = await audioSink.getFirstPacket();

    let wroteVideo = false;
    let wroteAudio = false;
    let videoPacketCount = 0;
    let audioPacketCount = 0;

    while (videoPacket || audioPacket) {
      const shouldWriteAudio =
        audioPacket !== null &&
        (videoPacket === null ||
          audioPacket.timestamp + audioTimestampOffset <= videoPacket.timestamp);

      if (shouldWriteAudio && audioPacket) {
        const shiftedTimestamp = audioPacket.timestamp + audioTimestampOffset;
        const shiftedEndTimestamp = shiftedTimestamp + audioPacket.duration;

        if (shiftedEndTimestamp > 0) {
          const shiftedPacket = audioPacket.clone({ timestamp: shiftedTimestamp });
          await audioSource.add(shiftedPacket, wroteAudio ? undefined : audioMeta);
          wroteAudio = true;
          audioPacketCount += 1;
        }

        audioPacket = await audioSink.getNextPacket(audioPacket);
        continue;
      }

      if (videoPacket) {
        await videoSource.add(videoPacket, wroteVideo ? undefined : videoMeta);
        wroteVideo = true;
        videoPacketCount += 1;
        videoPacket = await videoSink.getNextPacket(videoPacket);
      }
    }

    if (!wroteVideo || !wroteAudio) {
      console.warn(
        `[RecorderService] Desktop audio mux aborted: no usable ${wroteVideo ? 'desktop audio' : 'video'} packets.`,
      );
      await output.cancel();
      output = null;
      if (fs.existsSync(muxedOutputPath)) {
        fs.unlinkSync(muxedOutputPath);
      }
      return false;
    }

    console.log(
      `[RecorderService] Desktop audio mux packet summary: video=${videoPacketCount}, audio=${audioPacketCount}, baseOffset=${(videoStartTimestamp - audioStartTimestamp).toFixed(3)}s, appliedOffset=${audioTimestampOffset.toFixed(3)}s`,
    );

    await output.finalize();
    output = null;

    if (!fs.existsSync(muxedOutputPath)) {
      return false;
    }

    const validationInput = new Input({
      source: new FilePathSource(muxedOutputPath),
      formats: ALL_FORMATS,
    });

    try {
      const validationVideoTrack = await validationInput.getPrimaryVideoTrack();
      const validationAudioTrack = await validationInput.getPrimaryAudioTrack();
      const validationDuration = await validationInput.computeDuration();

      const validOutput =
        Boolean(validationVideoTrack) &&
        Boolean(validationAudioTrack) &&
        Number.isFinite(validationDuration) &&
        validationDuration > 0;

      if (!validOutput) {
        console.warn('[RecorderService] Desktop audio mux produced invalid output file.');
        fs.unlinkSync(muxedOutputPath);
        return false;
      }
    } finally {
      validationInput.dispose();
    }

    fs.unlinkSync(videoPath);
    fs.renameSync(muxedOutputPath, videoPath);
    return true;
  } catch (error) {
    console.error('[RecorderService] Mediabunny desktop audio mux failed:', error);

    try {
      if (output && output.state !== 'finalized' && output.state !== 'canceled') {
        await output.cancel();
      }
    } catch {
      // ignored
    }

    if (fs.existsSync(muxedOutputPath)) {
      fs.unlinkSync(muxedOutputPath);
    }

    return false;
  } finally {
    videoInput.dispose();
    audioInput.dispose();
  }
}

/**
 * Start a new recording session.
 *
 * Native screen/window video starts in velocity.
 * Camera/mic/system-audio streams are written by renderer via writeChunk.
 */
export function startRecording(config: RecordingConfig): StartRecordingResult {
  if (activeRecording) {
    return { success: false, error: 'A recording is already in progress' };
  }

  let stopper: VelocityStopper | null = null;
  const auxStreams: Record<string, AuxStreamState> = {};

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
    const nativeSystemAudioEnabled =
      process.platform === 'win32' && process.env.RECSO_ENABLE_NATIVE_SYSTEM_AUDIO === '1';
    const useNativeSystemAudio = Boolean(config.recordSystemAudio) && nativeSystemAudioEnabled;

    if (config.recordSystemAudio && !useNativeSystemAudio) {
      console.log(
        '[RecorderService] Native system audio disabled; using desktop audio sidecar + mux fallback.',
      );
    }
    const tempDir = ensureTempDir();
    const tempPath = path.join(tempDir, `rec_vel_${recordingId}.${fileExt}`);

    const selectedSourceId = config.sourceId;
    const selectedSourceMeta = sourceMetaById.get(selectedSourceId);
    const isScreenSource = selectedSourceMeta
      ? selectedSourceMeta.isScreen
      : selectedSourceId.startsWith('screen:') || selectedSourceId === 'screen';
    const useNativeSingularClock = shouldUseNativeSingularClock(config);
    const usePhoneCamera = config.cameraSource === 'phone';
    const nativeClockOptions: NativeClockOptions = {
      useSingularClock: useNativeSingularClock,
      targetFps: config.targetFps === 30 ? 30 : 60,
      enableWebcam: Boolean(config.recordCamera),
      webcamDeviceId: config.nativeWebcamDeviceId || config.cameraDeviceId,
      webcamSource: usePhoneCamera ? 'phone' : 'local',
    };
    let useNativeWebcam = false;
    let nativeWebcamDeviceId = nativeClockOptions.webcamDeviceId;

    if (nativeClockOptions.useSingularClock && nativeClockOptions.enableWebcam) {
      if (usePhoneCamera) {
        // A phone is only reachable through the native path, so there is no
        // renderer sidecar to fall back to. Refusing here beats starting a take
        // that silently records this machine's own webcam instead of the phone
        // the user just paired -- or worse, no camera track at all.
        const phone = phoneCameraState();
        if (!phone?.live) {
          return {
            success: false,
            error:
              'The phone is not sending a picture. Open the phone camera panel, scan the code, and tap Start camera before recording.',
          };
        }

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
          console.warn(
            `[RecorderService] Native webcam capture unavailable; falling back to renderer camera sidecar (${webcamCapability.reason || 'unknown reason'}).`,
          );
        }
      }
    }

    const effectiveNativeClockOptions: NativeClockOptions = {
      ...nativeClockOptions,
      enableWebcam: useNativeWebcam,
      webcamDeviceId: useNativeWebcam ? nativeWebcamDeviceId : undefined,
    };

    if (nativeClockOptions.useSingularClock) {
      console.log('[RecorderService] Native singular-clock capture mode enabled', {
        targetFps: nativeClockOptions.targetFps,
        webcamEnabled: useNativeWebcam,
        webcamRequested: nativeClockOptions.enableWebcam,
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
        if (!useNativeWebcam) {
          throw error;
        }

        if (usePhoneCamera) {
          // Nothing to fall back to: the renderer sidecar can only open a local
          // camera, and quietly recording that instead of the phone would be a
          // surprise discovered in the editor.
          return {
            success: false,
            error: `The phone camera would not start: ${error instanceof Error ? error.message : String(error)}`,
          };
        }

        console.warn(
          '[RecorderService] Native webcam start failed; falling back to renderer camera sidecar.',
          error,
        );

        useNativeWebcam = false;
        stopper = startVelocityMonitorRecording(velocity, tempPath, bitrate, useNativeSystemAudio, {
          ...effectiveNativeClockOptions,
          enableWebcam: false,
          webcamDeviceId: undefined,
        });
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
        if (!useNativeWebcam) {
          throw error;
        }

        if (usePhoneCamera) {
          // Nothing to fall back to: the renderer sidecar can only open a local
          // camera, and quietly recording that instead of the phone would be a
          // surprise discovered in the editor.
          return {
            success: false,
            error: `The phone camera would not start: ${error instanceof Error ? error.message : String(error)}`,
          };
        }

        console.warn(
          '[RecorderService] Native webcam start failed; falling back to renderer camera sidecar.',
          error,
        );

        useNativeWebcam = false;
        stopper = startVelocityWindowRecording(
          velocity,
          windowTitle,
          tempPath,
          bitrate,
          useNativeSystemAudio,
          {
            ...effectiveNativeClockOptions,
            enableWebcam: false,
            webcamDeviceId: undefined,
          },
        );
      }
    }

    if (config.recordCamera && !useNativeWebcam) {
      auxStreams.camera = openAuxStream(tempDir, recordingId, 'camera', fileExt);
    }

    const shouldWriteStandaloneMic = config.recordMic && (!config.recordCamera || useNativeWebcam);
    if (shouldWriteStandaloneMic) {
      auxStreams.mic = openAuxStream(tempDir, recordingId, 'mic', fileExt);
    }

    if (config.recordSystemAudio) {
      auxStreams['desktop-audio'] = openAuxStream(tempDir, recordingId, 'desktop-audio', fileExt);
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
      auxStreams,
    };

    console.log(
      '[RecorderService] Started hybrid recording:',
      recordingId,
      `aux=${Object.keys(auxStreams).join(',') || 'none'}`,
    );

    return {
      success: true,
      recordingId,
      tempPath,
      nativeWebcamHandled: useNativeWebcam,
    };
  } catch (error) {
    if (stopper) {
      try {
        stopper.stop();
      } catch {
        // ignored
      }
    }

    closeAuxStreams(auxStreams);
    cleanupAuxTempFiles(auxStreams);

    const safeError = getSafeStartRecordingError(error, config.sourceId);

    console.error('[RecorderService] Failed to start hybrid recording:', error);
    return {
      success: false,
      error: safeError,
    };
  }
}

/**
 * Legacy sequential append API (unused in hybrid flow).
 */
export function appendChunk(recordingId: string, _chunk: Buffer): boolean {
  return Boolean(activeRecording && activeRecording.id === recordingId);
}

/**
 * Write a chunk at a specific byte offset to an auxiliary stream.
 */
export function writeChunk(
  recordingId: string,
  streamId: string,
  position: number,
  chunk: Buffer,
): boolean {
  if (!activeRecording || activeRecording.id !== recordingId) {
    console.warn('[RecorderService] No active recording for writeChunk:', recordingId);
    return false;
  }

  const stream = activeRecording.auxStreams[streamId];
  if (!stream) {
    console.warn('[RecorderService] Unknown aux stream for writeChunk:', streamId);
    return false;
  }

  try {
    fs.writeSync(stream.fd, chunk, 0, chunk.length, position);
    stream.bytesWritten = Math.max(stream.bytesWritten, position + chunk.length);
    return true;
  } catch (error) {
    console.error('[RecorderService] Failed to write aux stream chunk:', streamId, error);
    return false;
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
      console.log(
        `[RecorderService] Recorder reported ${screenMedia.frames} frames, ` +
          `${screenMedia.width}x${screenMedia.height}, ` +
          `${(screenMedia.durationMs / 1000).toFixed(2)}s, ` +
          `${screenMedia.fps.toFixed(2)} fps measured (asked for ${screenMedia.configuredFps}), ` +
          `audio=${screenMedia.hasAudio}`,
      );
    }

    // Wait for the native capture loop to flush and close its output file before touching it.
    const finalizeStartedAtMs = Date.now();
    const nativeFileReady = await waitForNativeRecordingFile(currentRecording.tempPath);
    console.log(
      `[RecorderService] Native capture finalize took ${Date.now() - finalizeStartedAtMs}ms (ready=${nativeFileReady})`,
    );

    closeAuxStreams(currentRecording.auxStreams);

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

    const desktopAudioStream = currentRecording.auxStreams['desktop-audio'];

    Object.values(currentRecording.auxStreams).forEach((stream) => {
      if (stream.streamId === 'desktop-audio') {
        return;
      }

      if (!fs.existsSync(stream.tempPath)) {
        return;
      }

      const stats = fs.statSync(stream.tempPath);
      if (stats.size === 0) {
        fs.unlinkSync(stream.tempPath);
        return;
      }

      const finalAuxPath = path.join(
        recordingFolderPath,
        `${folderName}_${stream.streamId}.${currentRecording.fileExtension}`,
      );
      fs.renameSync(stream.tempPath, finalAuxPath);
    });

    if (desktopAudioStream && fs.existsSync(desktopAudioStream.tempPath)) {
      const desktopAudioStats = fs.statSync(desktopAudioStream.tempPath);
      if (desktopAudioStats.size === 0) {
        fs.unlinkSync(desktopAudioStream.tempPath);
      } else {
        // The recorder counted the audio bytes it actually captured, so this no
        // longer needs a demux pass to tell real audio from the empty AAC track
        // windows-capture always writes. Fall back to the old probe only when
        // the native side did not report anything.
        const nativeAudioAvailable = !currentRecording.nativeSystemAudioRequested
          ? false
          : screenMedia
            ? screenMedia.hasAudio
            : await hasPrimaryAudioTrack(finalScreenPath);

        if (nativeAudioAvailable) {
          fs.unlinkSync(desktopAudioStream.tempPath);
          console.log('[RecorderService] Native system audio was embedded by velocity.');
          completeRecording(
            recordingId,
            finalScreenPath,
            mediaAtFinalPath(screenMedia, finalScreenPath),
          );
          activeRecording = null;
          return {
            success: true,
            filePath: finalScreenPath,
            media: mediaAtFinalPath(screenMedia, finalScreenPath),
          };
        }

        const muxed = await muxDesktopAudioIntoVideo(
          finalScreenPath,
          desktopAudioStream.tempPath,
          currentRecording.fileExtension,
        );

        if (muxed) {
          fs.unlinkSync(desktopAudioStream.tempPath);
          console.log('[RecorderService] Embedded desktop audio into main recording file.');
        } else {
          const finalDesktopAudioPath = path.join(
            recordingFolderPath,
            `${folderName}_${desktopAudioStream.streamId}.${currentRecording.fileExtension}`,
          );
          fs.renameSync(desktopAudioStream.tempPath, finalDesktopAudioPath);
          console.warn(
            '[RecorderService] Failed to embed desktop audio. Saved sidecar file instead:',
            finalDesktopAudioPath,
          );
        }
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
 * Pause the active recording (state marker; render-side streams are paused in UI hook).
 */
export function pauseRecording(recordingId: string): boolean {
  if (!activeRecording || activeRecording.id !== recordingId) {
    return false;
  }

  console.warn('[RecorderService] Pause is not supported for hybrid velocity capture; continuing.');
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
    '[RecorderService] Resume is not supported for hybrid velocity capture; continuing.',
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

  bytesWritten += Object.values(activeRecording.auxStreams).reduce(
    (sum, stream) => sum + stream.bytesWritten,
    0,
  );

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
