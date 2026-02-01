/**
 * Mouse Smoothing Utilities
 *
 * This module provides mouse path processing using native Rust implementations
 * via the velocity N-API addon. The heavy computation (Catmull-Rom splines,
 * jitter removal, upsampling) happens in Rust for optimal performance.
 *
 * Key exports:
 *   smoothPath()           → Apply spline smoothing to mouse events (via Rust)
 *   interpolatePosition()  → Get smoothed position at any timestamp (via Rust)
 *   removeJitter()         → Remove small jitter movements (via Rust)
 */

import { createRequire } from 'module';
import type { RawMouseEvent, SmoothedPoint, SmoothingEventType, SmoothingOptions } from 'velocity';
import type * as Velocity from 'velocity';

import type { MouseEvent } from '../services/mouse-tracker.service.js';

// Import velocity - our custom Rust N-API addon
const require = createRequire(import.meta.url);
const velocity = require('velocity') as typeof Velocity;

// Re-export types from velocity for convenience
export type { RawMouseEvent, SmoothedPoint, SmoothingOptions } from 'velocity';

/**
 * Smoothed mouse event interface (matches velocity.SmoothedPoint)
 */
export interface SmoothedMouseEvent {
  recordingId: string;
  timestampMs: number;
  x: number;
  y: number;
  eventType: string;
  button: string | null;
  isInterpolated: boolean;
}

/**
 * Options for smoothing (matches velocity.SmoothingOptions)
 */
export interface SmoothingOptionsTS {
  /** Target FPS for upsampling (default: 60) */
  targetFps?: number;
  /** Spline tension 0-1, lower = smoother (default: 0.5) */
  tension?: number;
  /** Jitter threshold in pixels (default: 2) */
  jitterThreshold?: number;
  /** Whether to apply jitter removal (default: true) */
  removeJitter?: boolean;
}

/**
 * Convert internal MouseEvent to velocity RawMouseEvent format
 * Note: N-API auto-converts snake_case to camelCase, so we use camelCase
 */
function toRawMouseEvent(event: MouseEvent): RawMouseEvent {
  return {
    recordingId: event.recordingId,
    timestampMs: event.timestampMs,
    x: event.x,
    y: event.y,
    eventType: event.eventType as SmoothingEventType,
    button: event.button ?? undefined,
  };
}

/**
 * Convert velocity SmoothedPoint to SmoothedMouseEvent
 */
function fromSmoothedPoint(point: SmoothedPoint): SmoothedMouseEvent {
  return {
    recordingId: point.recordingId,
    timestampMs: point.timestampMs,
    x: point.x,
    y: point.y,
    eventType: point.eventType,
    button: point.button ?? null,
    isInterpolated: point.isInterpolated,
  };
}

/**
 * Apply Catmull-Rom spline smoothing to a sequence of mouse events.
 * This upsamples the path to create smoother cursor movement.
 * Uses native Rust implementation for performance.
 *
 * @param events - Original mouse events (30 FPS)
 * @param options - Smoothing options
 * @returns Smoothed and upsampled mouse events
 */
export function smoothPath(
  events: MouseEvent[],
  options: SmoothingOptionsTS = {},
): SmoothedMouseEvent[] {
  const rawEvents = events.map(toRawMouseEvent);

  const smoothedPoints = velocity.processMousePath(rawEvents, options);
  return smoothedPoints.map(fromSmoothedPoint);
}

/**
 * Get the interpolated mouse position at a specific timestamp.
 * Useful for rendering cursor at any frame time.
 * Uses native Rust implementation.
 *
 * @param events - Mouse events (can be smoothed or raw)
 * @param timestampMs - Target timestamp in milliseconds
 * @returns Interpolated position or null if out of range
 */
export function interpolatePosition(
  events: MouseEvent[],
  timestampMs: number,
): { x: number; y: number } | null {
  const rawEvents = events.map(toRawMouseEvent);

  const result = velocity.interpolatePositionAt(rawEvents, timestampMs);

  if (!result) {
    return null;
  }

  return { x: result.x, y: result.y };
}

/**
 * Apply jitter removal filter to mouse events.
 * Removes tiny movements that are likely hand shake.
 * Uses native Rust implementation via processMousePath with smoothing disabled.
 *
 * @param events - Mouse events
 * @param threshold - Minimum pixel distance to keep (default: 2)
 * @returns Filtered events with jitter removed
 */
export function removeJitter(events: MouseEvent[], threshold: number = 2): SmoothedMouseEvent[] {
  const rawEvents = events.map(toRawMouseEvent);

  // Use processMousePath with no upsampling, just jitter removal
  const options: SmoothingOptions = {
    targetFps: 30, // Same as input, no upsampling
    tension: 0.5,
    jitterThreshold: threshold,
    removeJitter: true,
  };

  const filteredPoints = velocity.processMousePath(rawEvents, options);
  return filteredPoints.map(fromSmoothedPoint);
}
