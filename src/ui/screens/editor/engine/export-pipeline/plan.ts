/**
 * Which exporter runs, and everything both of them need to know.
 *
 * The engine is the default now, because it is the only path that can open a
 * recording bigger than renderer memory. But it is not at parity with the
 * Canvas2D compositor yet, and an export that quietly drops a webcam cut is
 * worse than a slow one -- so anything the engine cannot draw sends the export
 * back to the old path, and the user is told which feature did it.
 *
 * The composition is built once, here, and handed to whichever runner wins.
 * Building it in each of them would be two chances to disagree about where the
 * webcam goes, and the disagreement would only ever show up in the output.
 */

import { getCutAdjustedDurationMs } from '../functions';
import type { UnsupportedFeature } from '../gpu-preview/unsupported';
import { unsupportedFeatures } from '../gpu-preview/unsupported';
import { resolveCroppedSourceDimensions } from '../source-crop';
import type { CompositionConfig } from '../types';
import { buildExportCompositionConfig } from './composition-config';
import { resolveLayout, resolveWebcamLayout } from './layout-resolver';
import { resolveOutputDimensions } from './settings';
import { resolveProjectWebcamSourcePath } from './source-paths';
import type { EngineCanvasExportOptions } from './types';

export interface ExportPlan {
  /** Whether the engine can draw this composition without losing anything. */
  native: boolean;
  /** What sent it back to the canvas path. Empty when `native` is true. */
  blockers: UnsupportedFeature[];
  composition: CompositionConfig;
  output: { width: number; height: number };
  webcamSourcePath: string | undefined;
  sourceDurationMs: number;
  compositionDurationMs: number;
}

type PlanInput = Pick<
  EngineCanvasExportOptions,
  'project' | 'config' | 'screenZoomRegions' | 'webcamZoomRegions' | 'mouseEvents'
>;

export async function planExport({
  project,
  config,
  screenZoomRegions,
  webcamZoomRegions,
  mouseEvents = [],
}: PlanInput): Promise<ExportPlan> {
  const output = resolveOutputDimensions(config);
  const screenCuts = project.cuts.filter((cut) => cut.targets?.screen ?? true);
  const sourceDurationMs = Math.max(0, project.timeline.duration || 0);

  const sourceDimensions = resolveCroppedSourceDimensions(
    {
      width: project.videoDimensions?.width || config.customWidth || 1920,
      height: project.videoDimensions?.height || config.customHeight || 1080,
    },
    project.cropConfig,
  );

  const webcamSourcePath = resolveProjectWebcamSourcePath(project);
  const layout = resolveLayout(
    project,
    sourceDimensions.width,
    sourceDimensions.height,
    output.width,
    output.height,
  );
  const webcamLayout =
    project.webcamOverlay?.enabled && webcamSourcePath
      ? await resolveWebcamLayout(output.width, output.height, project.webcamOverlay)
      : null;

  const composition = buildExportCompositionConfig({
    project,
    layout,
    webcamLayout,
    webcamSourcePath,
    sourceDurationMs,
    // The engine draws the background itself. The canvas path pre-renders one
    // and needs to know it is there; this flag is for that, and the native
    // runner overrides it when it wins.
    preserveUnderlyingBackground: false,
    screenZoomRegions,
    webcamZoomRegions,
    mouseEvents,
  });

  const blockers = unsupportedFeatures(composition);

  return {
    native: blockers.length === 0,
    blockers,
    composition,
    output,
    webcamSourcePath,
    sourceDurationMs,
    compositionDurationMs: getCutAdjustedDurationMs(sourceDurationMs, screenCuts),
  };
}
