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

export function mapSourceCutRangesToCompositionCutRanges(
  sourceCuts: CompositionCutRegion[],
  compositionCuts?: CompositionCutRegion[],
): CompositionCutRegion[] {
  const screenCuts = normaliseCuts(compositionCuts ?? []);
  const mappedCuts: CompositionCutRegion[] = [];

  for (const cut of normaliseCuts(sourceCuts)) {
    let segmentStartMs = cut.startMs;

    for (const screenCut of screenCuts) {
      if (screenCut.endMs <= segmentStartMs) {
        continue;
      }

      if (screenCut.startMs >= cut.endMs) {
        break;
      }

      const segmentEndMs = Math.min(screenCut.startMs, cut.endMs);
      if (segmentEndMs > segmentStartMs) {
        mappedCuts.push({
          id: `${cut.id}:${mappedCuts.length}`,
          startMs: mapSourceTimeToCompositionTimeMs(segmentStartMs, screenCuts),
          endMs: mapSourceTimeToCompositionTimeMs(segmentEndMs, screenCuts),
        });
      }

      segmentStartMs = Math.max(segmentStartMs, screenCut.endMs);
      if (segmentStartMs >= cut.endMs) {
        break;
      }
    }

    if (segmentStartMs < cut.endMs) {
      mappedCuts.push({
        id: `${cut.id}:${mappedCuts.length}`,
        startMs: mapSourceTimeToCompositionTimeMs(segmentStartMs, screenCuts),
        endMs: mapSourceTimeToCompositionTimeMs(cut.endMs, screenCuts),
      });
    }
  }

  return mappedCuts.filter((cut) => cut.endMs > cut.startMs);
}
