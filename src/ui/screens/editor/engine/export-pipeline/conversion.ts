import type { AudioSample, Input as MediabunnyInput, VideoSample } from 'mediabunny';

import type { ExportConfig } from '@/types';

import { CanvasFrameContext, createFrameCanvas, MediabunnySampleSource } from '../adapters';
import { CompositionEngine } from '../engine';
import { isInCutRegion, mapSourceTimeToCompositionTimeMs } from '../functions';
import type { CompositionConfig } from '../types';
import { resolveVideoBitrate } from './settings';
import type { BackgroundLayerCanvas, OutputDimensions, PreparedWebcamSource } from './types';

const PROGRESS_REPORT_INTERVAL_MS = 120;
const PROGRESS_REPORT_MIN_DELTA = 0.002;
const UI_YIELD_INTERVAL_MS = 120;

export interface RunConversionOptions {
  input: MediabunnyInput;
  config: ExportConfig;
  outputDimensions: OutputDimensions;
  compositionDurationMs: number;
  compositionConfig: CompositionConfig;
  backgroundLayer: BackgroundLayerCanvas | null;
  preparedWebcamSource: PreparedWebcamSource | null;
  cancelRequestedRef: { current: boolean };
  onProgress?: (fraction: number, totalFrames: number, startedAtMs: number) => void;
  onCancelHookReady?: (cancel: () => void) => void;
}

export async function runCanvasConversion({
  input,
  config,
  outputDimensions,
  compositionDurationMs,
  compositionConfig,
  backgroundLayer,
  preparedWebcamSource,
  cancelRequestedRef,
  onProgress,
  onCancelHookReady,
}: RunConversionOptions): Promise<{
  encodedBuffer: ArrayBuffer;
  totalFrames: number;
  startedAtMs: number;
}> {
  const { BufferTarget, Conversion, Mp4OutputFormat, Output } = await import('mediabunny');

  const engine = new CompositionEngine(compositionConfig);
  engine.setDuration(compositionDurationMs / 1000);

  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  });

  let frameContext: CanvasFrameContext | null = null;

  const ensureFrameContext = (): CanvasFrameContext => {
    if (frameContext) {
      return frameContext;
    }

    const frameCanvas = createFrameCanvas(outputDimensions.width, outputDimensions.height);
    frameContext = new CanvasFrameContext(frameCanvas);
    return frameContext;
  };

  const totalFrames = Math.max(1, Math.ceil((compositionDurationMs / 1000) * config.fps));
  const startedAtMs = performance.now();
  const safeCompositionDurationMs = Math.max(1, compositionDurationMs);
  const compositionDurationSeconds = Math.max(0.001, compositionDurationMs / 1000);
  let lastReportedFraction = 0;
  let lastProgressReportAtMs = 0;
  let lastUiYieldAtMs = 0;

  const reportProgress = (fraction: number, force = false): boolean => {
    if (!onProgress) {
      return false;
    }

    const clamped = Math.max(0, Math.min(1, fraction));
    const nextFraction = Math.max(lastReportedFraction, clamped);
    const now = performance.now();
    const hasMeaningfulChange = nextFraction - lastReportedFraction >= PROGRESS_REPORT_MIN_DELTA;
    const hasWaitedLongEnough = now - lastProgressReportAtMs >= PROGRESS_REPORT_INTERVAL_MS;

    if (!force && nextFraction < 1 && (!hasMeaningfulChange || !hasWaitedLongEnough)) {
      return false;
    }

    lastReportedFraction = nextFraction;
    lastProgressReportAtMs = now;
    onProgress(nextFraction, totalFrames, startedAtMs);
    return true;
  };

  const reportProgressAndYield = async (fraction: number, force = false): Promise<void> => {
    const reported = reportProgress(fraction, force);
    const now = performance.now();

    if (reported && now - lastUiYieldAtMs >= UI_YIELD_INTERVAL_MS) {
      lastUiYieldAtMs = now;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  };

  const conversion = await Conversion.init({
    input,
    output,
    video: {
      frameRate: config.fps,
      width: outputDimensions.width,
      height: outputDimensions.height,
      fit: 'fill',
      codec: 'avc',
      bitrate: resolveVideoBitrate(config),
      forceTranscode: true,
      processedWidth: outputDimensions.width,
      processedHeight: outputDimensions.height,
      process: async (sample: VideoSample) => {
        if (cancelRequestedRef.current) {
          return null;
        }

        const sourceTimeMs = sample.timestamp * 1000;
        if (isInCutRegion(sourceTimeMs, compositionConfig.cuts)) {
          await reportProgressAndYield(
            mapSourceTimeToCompositionTimeMs(sourceTimeMs, compositionConfig.cuts) /
              safeCompositionDurationMs,
          );
          return null;
        }

        const compositionTimeSeconds =
          mapSourceTimeToCompositionTimeMs(sourceTimeMs, compositionConfig.cuts) / 1000;

        sample.setTimestamp(compositionTimeSeconds);

        const context = ensureFrameContext();
        if (backgroundLayer) {
          const frameCtx = context.get2DContext();
          frameCtx.clearRect(0, 0, outputDimensions.width, outputDimensions.height);
          frameCtx.drawImage(
            backgroundLayer,
            0,
            0,
            outputDimensions.width,
            outputDimensions.height,
          );
        }

        if (preparedWebcamSource) {
          await preparedWebcamSource.syncToSeconds(sourceTimeMs / 1000);
        }

        engine.renderFrameAt(
          compositionTimeSeconds,
          context,
          new MediabunnySampleSource(sample),
          preparedWebcamSource?.frameSource ?? null,
        );

        await reportProgressAndYield(compositionTimeSeconds / compositionDurationSeconds);

        return context.getCanvas();
      },
    },
    audio: {
      process: (sample: AudioSample) => {
        if (cancelRequestedRef.current) {
          return null;
        }

        const sourceTimeMs = sample.timestamp * 1000;
        if (isInCutRegion(sourceTimeMs, compositionConfig.cuts)) {
          return null;
        }

        const compositionTimeSeconds =
          mapSourceTimeToCompositionTimeMs(sourceTimeMs, compositionConfig.cuts) / 1000;

        sample.setTimestamp(compositionTimeSeconds);
        return sample;
      },
    },
  });

  const cancel = (): void => {
    void conversion.cancel();
  };

  onCancelHookReady?.(cancel);

  if (cancelRequestedRef.current) {
    cancel();
    throw new Error('Export cancelled');
  }

  reportProgress(0, true);

  conversion.onProgress = (fraction) => {
    reportProgress(fraction);
  };

  await conversion.execute();
  reportProgress(1, true);

  const encodedBuffer = target.buffer;
  if (!encodedBuffer) {
    throw new Error('Encoded output buffer is empty');
  }

  return { encodedBuffer, totalFrames, startedAtMs };
}
