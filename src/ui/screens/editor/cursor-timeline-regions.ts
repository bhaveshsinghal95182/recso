import type { RecordedMouseEvent } from '@/types';

export interface CursorTimelineRegion {
  id: string;
  key: string;
  startMs: number;
  endMs: number;
}

export function resolveCursorRegionKey(event: RecordedMouseEvent): string {
  if (event.cursorHandleHex) {
    return `handle:${event.cursorHandleHex}`;
  }

  if (event.cursorDataUrl) {
    return `data:${event.cursorDataUrl.slice(0, 32)}`;
  }

  return 'default';
}

export function deriveCursorTimelineRegions(
  events: RecordedMouseEvent[],
  durationMs: number,
): CursorTimelineRegion[] {
  const boundedDuration = Math.max(0, durationMs);
  if (boundedDuration <= 0 || events.length === 0) {
    return [];
  }

  const sortedEvents = [...events]
    .filter((event) => Number.isFinite(event.timestampMs))
    .sort((a, b) => a.timestampMs - b.timestampMs);

  if (sortedEvents.length === 0) {
    return [];
  }

  const regions: CursorTimelineRegion[] = [];
  let regionIndex = 0;
  let activeKey = resolveCursorRegionKey(sortedEvents[0]);
  let regionStartMs = Math.max(0, Math.min(sortedEvents[0].timestampMs, boundedDuration));

  for (let index = 1; index < sortedEvents.length; index += 1) {
    const event = sortedEvents[index];
    const eventTimeMs = Math.max(0, Math.min(event.timestampMs, boundedDuration));
    const nextKey = resolveCursorRegionKey(event);
    if (nextKey === activeKey) {
      continue;
    }

    const endMs = Math.max(regionStartMs + 60, eventTimeMs);
    if (endMs > regionStartMs) {
      regions.push({
        id: `cursor-region-${regionIndex}`,
        key: activeKey,
        startMs: regionStartMs,
        endMs: Math.min(endMs, boundedDuration),
      });
      regionIndex += 1;
    }

    regionStartMs = eventTimeMs;
    activeKey = nextKey;
  }

  const tailEndMs = Math.max(regionStartMs + 60, boundedDuration);
  if (tailEndMs > regionStartMs) {
    regions.push({
      id: `cursor-region-${regionIndex}`,
      key: activeKey,
      startMs: regionStartMs,
      endMs: Math.min(tailEndMs, boundedDuration),
    });
  }

  return regions.filter((region) => region.endMs - region.startMs >= 40);
}
