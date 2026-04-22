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
  RecordingState,
  RecordingStateEvent,
  StartRecordingResult,
  StopRecordingResult,
} from '../types/recorder.types.js';
import { completeRecording, createRecording, getRecording } from './database.service.js';
import { initProjectFolder } from './project-storage.service.js';

interface VelocityStopper {
  stop(): void;
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
  }) => VelocityStopper;
  startWindowRecordingV2?: (options: {
    windowTitle: string;
    outputPath: string;
    bitrate: number;
    includeSystemAudio?: boolean;
    targetFps?: number;
    enableWebcam?: boolean;
    webcamDeviceId?: string;
  }) => VelocityStopper;
}

interface NativeClockOptions {
  useSingularClock: boolean;
  targetFps: 30 | 60;
  enableWebcam: boolean;
  webcamDeviceId?: string;
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

async function hasPrimaryAudioTrack(filePath: string): Promise<boolean> {
  const { ALL_FORMATS, FilePathSource, Input } = await import('mediabunny');

  const input = new Input({
    source: new FilePathSource(filePath),
    formats: ALL_FORMATS,
  });

  try {
    const audioTrack = await input.getPrimaryAudioTrack();
    return Boolean(audioTrack);
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
    const audioTimestampOffset = videoStartTimestamp - audioStartTimestamp;

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

    if (!wroteVideo) {
      console.warn('[RecorderService] Desktop audio mux aborted: no video packets available.');
      await output.cancel();
      output = null;
      return false;
    }

    if (!wroteAudio) {
      console.warn('[RecorderService] Desktop audio mux aborted: no usable desktop audio packets.');
      await output.cancel();
      output = null;
      return false;
    }

    console.log(
      `[RecorderService] Desktop audio mux packet summary: video=${videoPacketCount}, audio=${audioPacketCount}, offset=${audioTimestampOffset.toFixed(6)}`,
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
    const nativeClockOptions: NativeClockOptions = {
      useSingularClock: useNativeSingularClock,
      targetFps: config.targetFps === 30 ? 30 : 60,
      enableWebcam: Boolean(config.recordCamera),
      webcamDeviceId: config.nativeWebcamDeviceId || config.cameraDeviceId,
    };
    let useNativeWebcam = false;
    let nativeWebcamDeviceId = nativeClockOptions.webcamDeviceId;

    if (nativeClockOptions.useSingularClock && nativeClockOptions.enableWebcam) {
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
 */
export async function stopRecording(recordingId: string): Promise<StopRecordingResult> {
  if (!activeRecording || activeRecording.id !== recordingId) {
    return { success: false, error: 'No active recording with this ID' };
  }

  const currentRecording = activeRecording;

  try {
    currentRecording.stopper.stop();

    // Allow native capture loop to flush and close output file.
    await new Promise((resolve) => setTimeout(resolve, 350));

    closeAuxStreams(currentRecording.auxStreams);

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
        const nativeAudioAvailable = currentRecording.nativeSystemAudioRequested
          ? await hasPrimaryAudioTrack(finalScreenPath)
          : false;

        if (nativeAudioAvailable) {
          fs.unlinkSync(desktopAudioStream.tempPath);
          console.log('[RecorderService] Native system audio was embedded by velocity.');
          completeRecording(recordingId, finalScreenPath);
          activeRecording = null;
          return { success: true, filePath: finalScreenPath };
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

    completeRecording(recordingId, finalScreenPath);
    activeRecording = null;

    return { success: true, filePath: finalScreenPath };
  } catch (error) {
    console.error('[RecorderService] Failed to stop recording:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
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
