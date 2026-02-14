import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (!Number.isFinite(bytes) || bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);

  const parts = [
    hours.toString().padStart(2, '0'),
    minutes.toString().padStart(2, '0'),
    seconds.toString().padStart(2, '0'),
  ];

  if (hours === 0) {
    parts.shift(); // Remove hours if 0
  }

  return parts.join(':');
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
    // No event >= minTime. Check if the last event is within window?
    // Actually if binary search didn't find anything >= minTime, all are < minTime, so no match.
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

/**
 * Creates a debounced function that delays invoking func until after wait milliseconds have elapsed
 * since the last time the debounced function was invoked.
 */
export function debounce<T extends (...args: any[]) => void>(
  func: T,
  wait: number,
): T & { cancel: () => void } {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const debounced = (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      func(...args);
    }, wait);
  };

  debounced.cancel = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  };

  return debounced as T & { cancel: () => void };
}
