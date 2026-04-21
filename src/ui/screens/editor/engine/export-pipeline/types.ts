import type {
  ExportConfig,
  ExportProgress,
  Project,
  RecordedMouseEvent,
  ZoomRegion,
} from '@/types';

import type { CanvasCoverFrameSource } from '../adapters';

export interface EngineCanvasExportResult {
  buffer: ArrayBuffer;
  durationSeconds: number;
  fileSize: number;
}

export interface EngineCanvasExportOptions {
  project: Project;
  config: ExportConfig;
  screenZoomRegions?: ZoomRegion[];
  webcamZoomRegions?: ZoomRegion[];
  mouseEvents?: RecordedMouseEvent[];
  onProgress?: (progress: ExportProgress) => void;
  onCancelReady?: (cancel: () => void) => void;
}

export interface OutputDimensions {
  width: number;
  height: number;
}

export type BackgroundLayerCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface PreparedWebcamSource {
  frameSource: CanvasCoverFrameSource;
  syncToSeconds: (targetSeconds: number) => Promise<void>;
  dispose: () => void;
}
