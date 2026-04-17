import type { ExportProgress } from '@/types';

export function createProgressSnapshot(
  fraction: number,
  totalFrames: number,
  startedAtMs: number,
): ExportProgress {
  const clamped = Math.max(0, Math.min(1, fraction));
  const currentFrame = Math.min(totalFrames, Math.round(totalFrames * clamped));
  const elapsedSeconds = Math.max(0.001, (performance.now() - startedAtMs) / 1000);
  const fps = currentFrame / elapsedSeconds;
  const eta = clamped > 0 ? Math.max(0, Math.round((elapsedSeconds * (1 - clamped)) / clamped)) : 0;
  const percent = Math.round(clamped * 100);

  return {
    percent,
    currentFrame,
    totalFrames,
    fps,
    eta,
    stage: 'export',
    stagePercent: percent,
  };
}
