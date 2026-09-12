/**
 * Everything the native exporter needs to know.
 *
 * There is one export path. The composition is built once here and handed to
 * the engine; if the editor grows a feature the engine cannot draw, planning
 * fails with the feature's name instead of falling back to a renderer-memory
 * pipeline or quietly dropping it.
 */

import { getCutAdjustedDurationMs } from '../functions';
import { unsupportedFeatures } from '../gpu-preview/unsupported';
import { resolveCroppedSourceDimensions } from '../source-crop';
import type { CompositionConfig } from '../types';
import { buildExportCompositionConfig } from './composition-config';
import { resolveLayout, resolveWebcamLayout } from './layout-resolver';
import { resolveOutputDimensions } from './settings';
import { resolveProjectWebcamSourcePath } from './source-paths';
import type { ExportRequestOptions } from './types';

export interface ExportPlan {
  composition: CompositionConfig;
  output: { width: number; height: number };
  webcamSourcePath: string | undefined;
  sourceDurationMs: number;
  compositionDurationMs: number;
}

type PlanInput = Pick<
  ExportRequestOptions,
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

  const gaps = unsupportedFeatures(composition);
  if (gaps.length > 0) {
    throw new Error(
      `The native exporter cannot render this project yet: ${gaps.map((gap) => gap.label).join(', ')}`,
    );
  }

  return {
    composition,
    output,
    webcamSourcePath,
    sourceDurationMs,
    compositionDurationMs: getCutAdjustedDurationMs(sourceDurationMs, screenCuts),
  };
}
