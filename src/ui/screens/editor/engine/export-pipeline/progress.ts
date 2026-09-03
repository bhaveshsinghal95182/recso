import type { ExportProgress } from '@/types';

/** Weight of each stage in the overall progress bar (must sum to 1). */
const STAGE_WEIGHT = { composition: 0.7, export: 0.3 } as const;

export function createProgressSnapshot(
  fraction: number,
  totalFrames: number,
  startedAtMs: number,
  stage: ExportProgress['stage'] = 'export',
  phase = '',
  indeterminate = false,
): ExportProgress {
  const clamped = Math.max(0, Math.min(1, fraction));
  const currentFrame = Math.min(totalFrames, Math.round(totalFrames * clamped));
  const elapsedSeconds = Math.max(0.001, (performance.now() - startedAtMs) / 1000);
  const fps = currentFrame / elapsedSeconds;

  const stagePercent = Math.round(clamped * 100);

  // Overall percent is a weighted sum of completed stages + current stage progress.
  const completedWeight = stage === 'export' ? STAGE_WEIGHT.composition : 0;
  const currentWeight = stage === 'composition' ? STAGE_WEIGHT.composition : STAGE_WEIGHT.export;
  const percent = Math.min(100, Math.round((completedWeight + currentWeight * clamped) * 100));

  const eta =
    percent > 0 ? Math.max(0, Math.round((elapsedSeconds * (100 - percent)) / percent)) : 0;

  return {
    percent,
    currentFrame,
    totalFrames,
    fps,
    eta,
    stage,
    stagePercent,
    phase: phase || (stage === 'composition' ? 'Compositing frames' : 'Finishing up'),
    indeterminate,
  };
}
