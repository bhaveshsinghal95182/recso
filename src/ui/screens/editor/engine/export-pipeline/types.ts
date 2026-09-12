import type {
  ExportConfig,
  ExportProgress,
  Project,
  RecordedMouseEvent,
  ZoomRegion,
} from '@/types';

export interface ExportRequestOptions {
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
