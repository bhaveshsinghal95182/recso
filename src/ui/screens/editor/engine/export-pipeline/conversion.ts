import type { AudioSample, Input as MediabunnyInput, VideoSample } from 'mediabunny';

import type { ExportConfig } from '@/types';

import { CanvasFrameContext, createFrameCanvas, MediabunnySampleSource } from '../adapters';
import { CompositionEngine } from '../engine';
import { isInCutRegion, mapSourceTimeToCompositionTimeMs } from '../functions';
import type { CompositionConfig } from '../types';
import { resolveVideoBitrate } from './settings';
import type { BackgroundLayerCanvas, OutputDimensions, PreparedWebcamSource } from './types';

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

  conversion.onProgress = (fraction) => {
    onProgress?.(fraction, totalFrames, startedAtMs);
  };

  await conversion.execute();

  const encodedBuffer = target.buffer;
  if (!encodedBuffer) {
    throw new Error('Encoded output buffer is empty');
  }

  return { encodedBuffer, totalFrames, startedAtMs };
}
