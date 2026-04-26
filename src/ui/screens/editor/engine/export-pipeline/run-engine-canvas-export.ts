import { getCutAdjustedDurationMs } from '../functions';
import { buildStaticBackgroundLayer } from './background-layer';
import { buildExportCompositionConfig } from './composition-config';
import { runCanvasConversion } from './conversion';
import { resolveLayout, resolveWebcamLayout } from './layout-resolver';
import { createProgressSnapshot } from './progress';
import { resolveOutputDimensions } from './settings';
import { resolveProjectWebcamSourcePath, toFileUrl } from './source-paths';
import type {
  EngineCanvasExportOptions,
  EngineCanvasExportResult,
  PreparedWebcamSource,
} from './types';
import { appendWebcamAudioTrack } from './webcam-audio';
import { prepareWebcamSource } from './webcam-source';

export async function runEngineCanvasExport({
  project,
  config,
  screenZoomRegions,
  webcamZoomRegions,
  mouseEvents = [],
  onProgress,
  onCancelReady,
}: EngineCanvasExportOptions): Promise<EngineCanvasExportResult> {
  const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny');

  const sourceUrl = toFileUrl(project.rawVideoPath);
  if (!sourceUrl) {
    throw new Error('Source video path is missing');
  }

  const webcamSourcePath = resolveProjectWebcamSourcePath(project);
  const webcamSourceUrl = toFileUrl(webcamSourcePath);

  const cancelRequestedRef = { current: false };
  let cancelConversion: (() => void) | null = null;
  let preparedWebcamSource: PreparedWebcamSource | null = null;

  onCancelReady?.(() => {
    cancelRequestedRef.current = true;
    cancelConversion?.();
  });

  const response = await fetch(sourceUrl);
  if (!response.ok && response.status !== 0) {
    throw new Error(`Failed to read source video: ${response.status}`);
  }

  const sourceBlob = await response.blob();
  const input = new Input({
    source: new BlobSource(sourceBlob),
    formats: ALL_FORMATS,
  });

  try {
    const inputDurationMs = Math.max(0, Math.round((await input.computeDuration()) * 1000));
    const primaryVideoTrack = await input.getPrimaryVideoTrack();
    const sourceVideoWidth =
      project.videoDimensions?.width ||
      primaryVideoTrack?.displayWidth ||
      config.customWidth ||
      1920;
    const sourceVideoHeight =
      project.videoDimensions?.height ||
      primaryVideoTrack?.displayHeight ||
      config.customHeight ||
      1080;

    const sourceDurationMs = Math.max(0, project.timeline.duration || inputDurationMs);
    const compositionDurationMs = getCutAdjustedDurationMs(sourceDurationMs, project.cuts);
    const outputDimensions = resolveOutputDimensions(config);
    const layout = await resolveLayout(
      sourceVideoWidth,
      sourceVideoHeight,
      outputDimensions.width,
      outputDimensions.height,
    );

    const webcamLayout =
      project.webcamOverlay?.enabled && webcamSourcePath
        ? await resolveWebcamLayout(
            outputDimensions.width,
            outputDimensions.height,
            project.webcamOverlay,
          )
        : null;

    if (project.webcamOverlay?.enabled && webcamSourceUrl) {
      preparedWebcamSource = await prepareWebcamSource(webcamSourceUrl);
      if (!preparedWebcamSource) {
        console.warn(
          '[EngineCanvasExport] Webcam overlay enabled but webcam source could not be prepared.',
        );
      }
    }

    const backgroundLayer = await buildStaticBackgroundLayer(
      project,
      outputDimensions.width,
      outputDimensions.height,
    );

    const compositionConfig = buildExportCompositionConfig({
      project,
      layout,
      webcamLayout,
      webcamSourcePath,
      sourceDurationMs,
      preserveUnderlyingBackground: backgroundLayer !== null,
      screenZoomRegions,
      webcamZoomRegions,
      mouseEvents,
    });

    const { encodedBuffer, totalFrames, startedAtMs } = await runCanvasConversion({
      input,
      config,
      outputDimensions,
      compositionDurationMs,
      compositionConfig,
      backgroundLayer,
      preparedWebcamSource,
      cancelRequestedRef,
      onProgress: (fraction, totalFrames, startedAtMs) => {
        onProgress?.(createProgressSnapshot(fraction, totalFrames, startedAtMs, 'composition'));
      },
      onCancelHookReady: (cancel) => {
        cancelConversion = cancel;
      },
    });

    // Report composition complete, export starting
    onProgress?.(createProgressSnapshot(1, totalFrames, startedAtMs, 'composition'));

    const outputBuffer =
      project.webcamOverlay?.enabled && webcamSourceUrl
        ? await appendWebcamAudioTrack(
            encodedBuffer,
            webcamSourceUrl,
            compositionConfig.cuts,
            compositionDurationMs / 1000,
            () => cancelRequestedRef.current,
            (fraction) => {
              onProgress?.(createProgressSnapshot(fraction, totalFrames, startedAtMs, 'export'));
            },
          )
        : encodedBuffer;

    onProgress?.(createProgressSnapshot(1, totalFrames, startedAtMs, 'export'));

    return {
      buffer: outputBuffer,
      durationSeconds: compositionDurationMs / 1000,
      fileSize: outputBuffer.byteLength,
    };
  } catch (error) {
    if (cancelRequestedRef.current) {
      throw new Error('Export cancelled');
    }
    throw error;
  } finally {
    preparedWebcamSource?.dispose();
    input.dispose();
  }
}
