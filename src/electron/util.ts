export function isDevelopment() {
  return process.env.NODE_ENV === 'development';
}

/**
 * Generic binary search to find the closest event within a time window.
 * Assumes events are sorted by timestampMs.
 * Returns null if no event is found within the window.
 */
export function findClosestEventInWindow<T extends { timestampMs: number }>(
  events: T[],
  targetTime: number,
  windowMs: number,
): T | null {
  if (!events || events.length === 0) return null;

  // 1. Binary search for the lower bound (first event >= targetTime - windowMs)
  let left = 0;
  let right = events.length - 1;
  let startIndex = -1;

  const minTime = targetTime - windowMs;
  const maxTime = targetTime + windowMs;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (events[mid].timestampMs >= minTime) {
      startIndex = mid;
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  if (startIndex === -1) {
    return null;
  }

  // 2. Linear scan from startIndex to find closest
  let closest: T | null = null;
  let minDiff = Infinity;

  for (let i = startIndex; i < events.length; i++) {
    const event = events[i];
    if (event.timestampMs > maxTime) {
      break; // Out of window
    }

    const diff = Math.abs(event.timestampMs - targetTime);
    if (diff < minDiff) {
      minDiff = diff;
      closest = event;
    }
  }

  return closest;
}
