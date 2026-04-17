import { CanvasCoverFrameSource } from '../adapters';
import type { PreparedWebcamSource } from './types';

export async function prepareWebcamSource(sourceUrl: string): Promise<PreparedWebcamSource | null> {
  const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import('mediabunny');

  let webcamResponse: Response;
  try {
    webcamResponse = await fetch(sourceUrl);
    if (!webcamResponse.ok && webcamResponse.status !== 0) {
      console.warn('[EngineCanvasExport] Failed to fetch webcam source:', webcamResponse.status);
      return null;
    }
  } catch (error) {
    console.warn('[EngineCanvasExport] Failed to fetch webcam source:', error);
    return null;
  }

  const webcamBlob = await webcamResponse.blob();
  const webcamInput = new Input({
    source: new BlobSource(webcamBlob),
    formats: ALL_FORMATS,
  });

  const webcamVideoTrack = await webcamInput.getPrimaryVideoTrack();
  if (!webcamVideoTrack) {
    console.warn('[EngineCanvasExport] Webcam source has no video track.');
    webcamInput.dispose();
    return null;
  }

  const canvasSink = new CanvasSink(webcamVideoTrack);
  const frameSource = new CanvasCoverFrameSource();

  // Use sequential iterator instead of random-access getCanvas().
  // canvases() pre-decodes frames ahead and decodes each packet at most once,
  // whereas getCanvas() re-seeks from the nearest keyframe every call.
  const frameIterator = canvasSink.canvases();
  let currentCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  let nextFrame = await frameIterator.next();

  const syncToSeconds = async (targetSeconds: number): Promise<void> => {
    if (!Number.isFinite(targetSeconds)) {
      frameSource.setCanvas(null);
      return;
    }

    const target = Math.max(0, targetSeconds);

    // Advance the iterator forward until we reach or pass the target timestamp.
    // Since export timestamps are monotonically increasing, each frame is decoded
    // at most once across the entire export - O(n) total.
    while (!nextFrame.done && nextFrame.value.timestamp <= target) {
      currentCanvas = nextFrame.value.canvas;
      nextFrame = await frameIterator.next();
    }

    frameSource.setCanvas(currentCanvas);
  };

  return {
    frameSource,
    syncToSeconds,
    dispose: () => {
      frameSource.setCanvas(null);
      void frameIterator.return(undefined);
      webcamInput.dispose();
    },
  };
}
