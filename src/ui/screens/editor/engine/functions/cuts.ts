import type { CompositionCutRegion } from '../types';

function normaliseCuts(cuts: CompositionCutRegion[]): CompositionCutRegion[] {
  const sorted = [...cuts]
    .map((cut) => ({
      ...cut,
      startMs: Math.max(0, cut.startMs),
      endMs: Math.max(0, cut.endMs),
    }))
    .filter((cut) => cut.endMs > cut.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const merged: CompositionCutRegion[] = [];
  for (const cut of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && cut.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, cut.endMs);
      continue;
    }

    merged.push({ ...cut });
  }

  return merged;
}

function getCutDurationBeforeTimeMs(timestampMs: number, cuts?: CompositionCutRegion[]): number {
  if (!cuts?.length) {
    return 0;
  }

  let skippedMs = 0;
  for (const cut of normaliseCuts(cuts)) {
    if (timestampMs <= cut.startMs) {
      break;
    }

    const cutEnd = Math.min(timestampMs, cut.endMs);
    if (cutEnd > cut.startMs) {
      skippedMs += cutEnd - cut.startMs;
    }
  }

  return skippedMs;
}

export function isInCutRegion(timestampMs: number, cuts?: CompositionCutRegion[]): boolean {
  if (!cuts?.length) {
    return false;
  }

  for (const cut of normaliseCuts(cuts)) {
    if (timestampMs >= cut.startMs && timestampMs < cut.endMs) {
      return true;
    }
  }

  return false;
}

export function mapCompositionToSourceTimeMs(
  compositionTimeMs: number,
  cuts?: CompositionCutRegion[],
): number {
  if (!cuts?.length) {
    return Math.max(0, compositionTimeMs);
  }

  let sourceMs = Math.max(0, compositionTimeMs);
  for (const cut of normaliseCuts(cuts)) {
    if (sourceMs < cut.startMs) {
      break;
    }

    sourceMs += cut.endMs - cut.startMs;
  }

  return sourceMs;
}

export function mapSourceTimeToCompositionTimeMs(
  sourceTimeMs: number,
  cuts?: CompositionCutRegion[],
): number {
  const safeTimeMs = Math.max(0, sourceTimeMs);
  return Math.max(0, safeTimeMs - getCutDurationBeforeTimeMs(safeTimeMs, cuts));
}

export function getCutAdjustedDurationMs(
  sourceDurationMs: number,
  cuts?: CompositionCutRegion[],
): number {
  const safeDurationMs = Math.max(0, sourceDurationMs);
  if (!cuts?.length) {
    return safeDurationMs;
  }

  return Math.max(0, safeDurationMs - getCutDurationBeforeTimeMs(safeDurationMs, cuts));
}
