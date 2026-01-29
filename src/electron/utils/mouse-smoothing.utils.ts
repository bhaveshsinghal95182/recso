/**
 * Mouse Smoothing Utilities
 *
 * Implements Catmull-Rom spline interpolation for smoothing mouse paths.
 * This creates natural-looking curves between sampled mouse positions,
 * eliminating jitter while preserving intentional movements.
 *
 * Key exports:
 *   smoothPath()           → Apply spline smoothing to mouse events
 *   interpolatePosition()  → Get smoothed position at any timestamp
 *   catmullRomSpline()     → Core spline interpolation function
 */

import type { MouseEvent, MouseEventType } from '../services/mouse-tracker.service.js';

/**
 * Point interface for 2D coordinates
 */
interface Point {
  x: number;
  y: number;
}

/**
 * Smoothed mouse event with interpolated positions
 */
export interface SmoothedMouseEvent extends MouseEvent {
  originalX?: number;
  originalY?: number;
  isInterpolated?: boolean;
}

/**
 * Catmull-Rom spline interpolation between four control points
 * Returns the interpolated point at parameter t (0 to 1)
 *
 * @param p0 - Control point before the segment
 * @param p1 - Start of segment
 * @param p2 - End of segment
 * @param p3 - Control point after the segment
 * @param t - Parameter (0 = p1, 1 = p2)
 * @param tension - Tension factor (0.5 = standard Catmull-Rom)
 */
export function catmullRomSpline(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  t: number,
  tension: number = 0.5,
): Point {
  const t2 = t * t;
  const t3 = t2 * t;

  // Catmull-Rom basis functions
  const s = (1 - tension) / 2;

  const b0 = -s * t3 + 2 * s * t2 - s * t;
  const b1 = (2 - s) * t3 + (s - 3) * t2 + 1;
  const b2 = (s - 2) * t3 + (3 - 2 * s) * t2 + s * t;
  const b3 = s * t3 - s * t2;

  return {
    x: Math.round(b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x),
    y: Math.round(b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y),
  };
}

/**
 * Apply Catmull-Rom spline smoothing to a sequence of mouse events.
 * This upsamples the path to create smoother cursor movement.
 *
 * @param events - Original mouse events (30 FPS)
 * @param targetFps - Target framerate for output (60 or 120 FPS)
 * @param tension - Stiffness of the spline (0-1, lower = smoother)
 * @returns Smoothed and upsampled mouse events
 */
export function smoothPath(
  events: MouseEvent[],
  targetFps: number = 60,
  tension: number = 0.5,
): SmoothedMouseEvent[] {
  if (events.length < 2) {
    return events.map((e) => ({ ...e, isInterpolated: false }));
  }

  // Filter to only movement events for smoothing
  const moveEvents = events.filter((e) => e.eventType === 'move' || e.eventType === 'drag');
  const otherEvents = events.filter((e) => e.eventType !== 'move' && e.eventType !== 'drag');

  if (moveEvents.length < 2) {
    return events.map((e) => ({ ...e, isInterpolated: false }));
  }

  const smoothedMoves: SmoothedMouseEvent[] = [];

  // Calculate time per frame at target FPS
  const frameTimeMs = 1000 / targetFps;

  for (let i = 0; i < moveEvents.length - 1; i++) {
    const current = moveEvents[i];
    const next = moveEvents[i + 1];

    // Get control points for Catmull-Rom
    const p0 = i > 0 ? moveEvents[i - 1] : current;
    const p1 = current;
    const p2 = next;
    const p3 = i < moveEvents.length - 2 ? moveEvents[i + 2] : next;

    // Add original point
    smoothedMoves.push({
      ...current,
      originalX: current.x,
      originalY: current.y,
      isInterpolated: false,
    });

    // Calculate how many interpolated frames to add
    const timeDiff = next.timestampMs - current.timestampMs;
    const numInterpolatedFrames = Math.floor(timeDiff / frameTimeMs) - 1;

    // Add interpolated points
    for (let j = 1; j <= numInterpolatedFrames; j++) {
      const t = j / (numInterpolatedFrames + 1);
      const interpolatedPoint = catmullRomSpline(
        { x: p0.x, y: p0.y },
        { x: p1.x, y: p1.y },
        { x: p2.x, y: p2.y },
        { x: p3.x, y: p3.y },
        t,
        tension,
      );

      const interpolatedEvent: SmoothedMouseEvent = {
        recordingId: current.recordingId,
        timestampMs: Math.round(current.timestampMs + timeDiff * t),
        x: interpolatedPoint.x,
        y: interpolatedPoint.y,
        eventType: current.eventType as MouseEventType,
        button: null,
        meta: null,
        isInterpolated: true,
      };

      smoothedMoves.push(interpolatedEvent);
    }
  }

  // Add the last point
  const lastMove = moveEvents[moveEvents.length - 1];
  smoothedMoves.push({
    ...lastMove,
    originalX: lastMove.x,
    originalY: lastMove.y,
    isInterpolated: false,
  });

  // Merge smoothed moves with click/scroll events, sorted by timestamp
  const allEvents = [
    ...smoothedMoves,
    ...otherEvents.map((e) => ({ ...e, isInterpolated: false })),
  ];
  allEvents.sort((a, b) => a.timestampMs - b.timestampMs);

  return allEvents;
}

/**
 * Get the interpolated mouse position at a specific timestamp.
 * Useful for rendering cursor at any frame time.
 *
 * @param events - Mouse events (can be smoothed or raw)
 * @param timestampMs - Target timestamp in milliseconds
 * @returns Interpolated position or null if out of range
 */
export function interpolatePosition(events: MouseEvent[], timestampMs: number): Point | null {
  if (events.length === 0) return null;

  // Find the two events surrounding the timestamp
  const moveEvents = events.filter((e) => e.eventType === 'move' || e.eventType === 'drag');

  if (moveEvents.length === 0) return null;

  // Before first event
  if (timestampMs <= moveEvents[0].timestampMs) {
    return { x: moveEvents[0].x, y: moveEvents[0].y };
  }

  // After last event
  const lastEvent = moveEvents[moveEvents.length - 1];
  if (timestampMs >= lastEvent.timestampMs) {
    return { x: lastEvent.x, y: lastEvent.y };
  }

  // Find surrounding events
  let prev: MouseEvent | null = null;
  let next: MouseEvent | null = null;

  for (let i = 0; i < moveEvents.length - 1; i++) {
    if (moveEvents[i].timestampMs <= timestampMs && moveEvents[i + 1].timestampMs >= timestampMs) {
      prev = moveEvents[i];
      next = moveEvents[i + 1];
      break;
    }
  }

  if (!prev || !next) {
    return null;
  }

  // Linear interpolation between the two points
  const t = (timestampMs - prev.timestampMs) / (next.timestampMs - prev.timestampMs);

  return {
    x: Math.round(prev.x + (next.x - prev.x) * t),
    y: Math.round(prev.y + (next.y - prev.y) * t),
  };
}

/**
 * Apply jitter removal filter to mouse events.
 * Removes tiny movements that are likely hand shake.
 *
 * @param events - Mouse events
 * @param threshold - Minimum pixel distance to keep (default: 2)
 * @returns Filtered events with jitter removed
 */
export function removeJitter(events: MouseEvent[], threshold: number = 2): MouseEvent[] {
  if (events.length < 2) return events;

  const filtered: MouseEvent[] = [events[0]];
  let lastKeptEvent = events[0];

  for (let i = 1; i < events.length; i++) {
    const current = events[i];

    // Always keep non-move events (clicks, scrolls)
    if (current.eventType !== 'move' && current.eventType !== 'drag') {
      filtered.push(current);
      continue;
    }

    // Calculate distance from last kept position
    const dx = current.x - lastKeptEvent.x;
    const dy = current.y - lastKeptEvent.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Only keep if moved more than threshold
    if (distance >= threshold) {
      filtered.push(current);
      lastKeptEvent = current;
    }
  }

  return filtered;
}
