/**
 * MouseTrackerService — quick overview:
 * - Tracks mouse position at 30 FPS (33ms intervals) during recording
 * - Captures immediate events: clicks, scrolls, drags via native Rust hooks (velocity)
 * - Buffers events in memory and flushes to SQLite periodically
 * - Uses custom Rust N-API addon (velocity) for global mouse hooks
 *
 * Key exports:
 *   MouseTrackerService (singleton class)
 *   - startTracking(recordingId)  → Begin tracking for a recording
 *   - stopTracking()              → Stop and flush remaining events
 *   - getEventsForRecording(id)   → Retrieve all events
 *   - getEventsInRange(id, start, end) → Retrieve events in time range
 *   - deleteEventsForRecording(id) → Cleanup events
 */

import { screen } from 'electron';

import { createRequire } from 'module';
import type * as Velocity from 'velocity';

import { getDatabase } from './database.service.js';

// Import velocity - our custom Rust N-API addon for mouse hooks
// Native .node addons must be loaded via require(), so we use createRequire in ESM
const require = createRequire(import.meta.url);
const velocity = require('velocity') as typeof Velocity;

// Mouse event types
export type MouseEventType = 'move' | 'click' | 'scroll' | 'drag';
export type MouseButton = 'left' | 'right' | 'middle' | null;

// Mouse event interface matching database schema
export interface MouseEvent {
  id?: number;
  recordingId: string;
  timestampMs: number;
  x: number;
  y: number;
  eventType: MouseEventType;
  button: MouseButton;
  meta: {
    scrollDeltaX?: number;
    scrollDeltaY?: number;
    isPressed?: boolean;
    modifiers?: {
      ctrl: boolean;
      shift: boolean;
      alt: boolean;
      meta: boolean;
    };
  } | null;
}

// Sampling rate: 30 FPS = ~33.33ms per sample
const SAMPLE_INTERVAL_MS = 33;
// Flush interval: every 1 second
const FLUSH_INTERVAL_MS = 1000;

class MouseTrackerService {
  private static instance: MouseTrackerService | null = null;

  private recordingId: string | null = null;
  private recordingStartTime: number = 0;
  private eventBuffer: MouseEvent[] = [];

  private sampleTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastSampleTime: number = 0;
  private lastPosition: { x: number; y: number } = { x: 0, y: 0 };
  private isMousePressed: boolean = false;

  private isTracking: boolean = false;

  private constructor() {
    // Private constructor for singleton
  }

  static getInstance(): MouseTrackerService {
    if (!MouseTrackerService.instance) {
      MouseTrackerService.instance = new MouseTrackerService();
    }
    return MouseTrackerService.instance;
  }

  /**
   * Initialize - no-op now since velocity is loaded synchronously
   */
  async initialize(): Promise<void> {
    console.log('[MouseTrackerService] Using velocity Rust addon for mouse hooks');
  }

  /**
   * Start tracking mouse events for a recording
   */
  startTracking(recordingId: string): void {
    if (this.isTracking) {
      console.warn('[MouseTrackerService] Already tracking, stopping previous session');
      this.stopTracking();
    }

    this.recordingId = recordingId;
    this.recordingStartTime = Date.now();
    this.eventBuffer = [];
    this.lastSampleTime = 0;
    this.isTracking = true;

    // Get initial cursor position
    const cursorPoint = screen.getCursorScreenPoint();
    this.lastPosition = { x: cursorPoint.x, y: cursorPoint.y };

    // Start position sampling timer (30 FPS) for move events
    this.sampleTimer = setInterval(() => this.samplePosition(), SAMPLE_INTERVAL_MS);

    // Start flush timer (every 1 second)
    this.flushTimer = setInterval(() => this.flushBuffer(), FLUSH_INTERVAL_MS);

    // Register velocity hooks for clicks and scrolls
    this.registerVelocityHooks();

    console.log('[MouseTrackerService] Started tracking for recording:', recordingId);
  }

  /**
   * Stop tracking and flush remaining events
   */
  stopTracking(): number {
    if (!this.isTracking) {
      return 0;
    }

    // Clear timers
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Stop velocity hooks
    try {
      velocity.stopHook();
    } catch (error) {
      console.error('[MouseTrackerService] Error stopping velocity hooks:', error);
    }

    // Flush remaining events
    this.flushBuffer();

    const totalEvents = this.getTotalEventCount();

    // Reset state
    this.isTracking = false;
    this.recordingId = null;

    console.log('[MouseTrackerService] Stopped tracking. Total events:', totalEvents);
    return totalEvents;
  }

  /**
   * Sample current cursor position (called at 30 FPS)
   */
  private samplePosition(): void {
    if (!this.recordingId) return;

    const now = Date.now();
    const elapsed = now - this.lastSampleTime;

    // Only sample if enough time has passed
    if (elapsed < SAMPLE_INTERVAL_MS) return;

    const cursorPoint = screen.getCursorScreenPoint();

    // Only record if position changed
    if (cursorPoint.x !== this.lastPosition.x || cursorPoint.y !== this.lastPosition.y) {
      const event: MouseEvent = {
        recordingId: this.recordingId,
        timestampMs: now - this.recordingStartTime,
        x: cursorPoint.x,
        y: cursorPoint.y,
        eventType: this.isMousePressed ? 'drag' : 'move',
        button: null,
        meta: null,
      };

      this.eventBuffer.push(event);
      this.lastPosition = { x: cursorPoint.x, y: cursorPoint.y };
    }

    this.lastSampleTime = now;
  }

  /**
   * Register velocity (Rust) mouse hooks
   */
  private registerVelocityHooks(): void {
    try {
      velocity.startMouseHook((err, event) => {
        if (err) {
          console.error('[MouseTrackerService] Velocity hook error:', err);
          return;
        }

        // Handle click events
        if (event.eventType === 'mousedown') {
          this.isMousePressed = true;
          this.recordClickEvent(event, true);
        } else if (event.eventType === 'mouseup') {
          this.isMousePressed = false;
          this.recordClickEvent(event, false);
        } else if (event.eventType === 'scroll') {
          this.recordScrollEvent(event);
        }
        // Note: 'move' events are handled by the interval timer for 30 FPS sampling
      });
    } catch (error) {
      console.error('[MouseTrackerService] Failed to start velocity hooks:', error);
    }
  }

  /**
   * Record a click event (bypasses sampling - immediate)
   */
  private recordClickEvent(
    hookEvent: { x: number; y: number; button?: string },
    isPressed: boolean,
  ): void {
    if (!this.recordingId) return;

    const button: MouseButton = (hookEvent.button as MouseButton) ?? null;

    const event: MouseEvent = {
      recordingId: this.recordingId,
      timestampMs: Date.now() - this.recordingStartTime,
      x: hookEvent.x,
      y: hookEvent.y,
      eventType: 'click',
      button,
      meta: {
        isPressed,
      },
    };

    this.eventBuffer.push(event);
  }

  /**
   * Record a scroll event (bypasses sampling - immediate)
   */
  private recordScrollEvent(hookEvent: { x: number; y: number; scrollDelta?: number }): void {
    if (!this.recordingId) return;

    const event: MouseEvent = {
      recordingId: this.recordingId,
      timestampMs: Date.now() - this.recordingStartTime,
      x: hookEvent.x,
      y: hookEvent.y,
      eventType: 'scroll',
      button: null,
      meta: {
        scrollDeltaX: 0,
        scrollDeltaY: hookEvent.scrollDelta ?? 0,
      },
    };

    this.eventBuffer.push(event);
  }

  /**
   * Flush event buffer to SQLite
   */
  private flushBuffer(): void {
    if (this.eventBuffer.length === 0) return;

    try {
      const db = getDatabase();
      const stmt = db.prepare(`
        INSERT INTO mouse_events (recording_id, timestamp_ms, x, y, event_type, button, meta)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      // Use transaction for batch insert
      const insertMany = db.transaction((events: MouseEvent[]) => {
        for (const event of events) {
          stmt.run(
            event.recordingId,
            event.timestampMs,
            event.x,
            event.y,
            event.eventType,
            event.button,
            event.meta ? JSON.stringify(event.meta) : null,
          );
        }
      });

      insertMany(this.eventBuffer);

      console.log('[MouseTrackerService] Flushed', this.eventBuffer.length, 'events to database');
      this.eventBuffer = [];
    } catch (error) {
      console.error('[MouseTrackerService] Failed to flush events:', error);
    }
  }

  /**
   * Get total event count for current recording
   */
  private getTotalEventCount(): number {
    if (!this.recordingId) return 0;

    try {
      const db = getDatabase();
      const stmt = db.prepare('SELECT COUNT(*) as count FROM mouse_events WHERE recording_id = ?');
      const result = stmt.get(this.recordingId) as { count: number };
      return result.count + this.eventBuffer.length;
    } catch {
      return this.eventBuffer.length;
    }
  }

  /**
   * Get all events for a recording
   */
  getEventsForRecording(recordingId: string): MouseEvent[] {
    try {
      const db = getDatabase();
      const stmt = db.prepare(`
        SELECT * FROM mouse_events
        WHERE recording_id = ?
        ORDER BY timestamp_ms ASC
      `);
      const rows = stmt.all(recordingId) as Array<Record<string, unknown>>;

      return rows.map(this.mapRowToEvent);
    } catch (error) {
      console.error('[MouseTrackerService] Failed to get events:', error);
      return [];
    }
  }

  /**
   * Get events in a specific time range
   */
  getEventsInRange(recordingId: string, startMs: number, endMs: number): MouseEvent[] {
    try {
      const db = getDatabase();
      const stmt = db.prepare(`
        SELECT * FROM mouse_events
        WHERE recording_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ?
        ORDER BY timestamp_ms ASC
      `);
      const rows = stmt.all(recordingId, startMs, endMs) as Array<Record<string, unknown>>;

      return rows.map(this.mapRowToEvent);
    } catch (error) {
      console.error('[MouseTrackerService] Failed to get events in range:', error);
      return [];
    }
  }

  /**
   * Delete all events for a recording
   */
  deleteEventsForRecording(recordingId: string): void {
    try {
      const db = getDatabase();
      const stmt = db.prepare('DELETE FROM mouse_events WHERE recording_id = ?');
      stmt.run(recordingId);
      console.log('[MouseTrackerService] Deleted events for recording:', recordingId);
    } catch (error) {
      console.error('[MouseTrackerService] Failed to delete events:', error);
    }
  }

  /**
   * Get debug status for developer tools
   */
  getDebugStatus(): {
    isTracking: boolean;
    recordingId: string | null;
    bufferSize: number;
    lastPosition: { x: number; y: number };
    totalEvents: number;
    recentBufferEvents: MouseEvent[];
  } {
    return {
      isTracking: this.isTracking,
      recordingId: this.recordingId,
      bufferSize: this.eventBuffer.length,
      lastPosition: this.lastPosition,
      totalEvents: this.getTotalEventCount(),
      recentBufferEvents: this.eventBuffer.slice(-5),
    };
  }

  /**
   * Map database row to MouseEvent
   */
  private mapRowToEvent(row: Record<string, unknown>): MouseEvent {
    return {
      id: row.id as number,
      recordingId: row.recording_id as string,
      timestampMs: row.timestamp_ms as number,
      x: row.x as number,
      y: row.y as number,
      eventType: row.event_type as MouseEventType,
      button: (row.button as MouseButton) ?? null,
      meta: row.meta ? JSON.parse(row.meta as string) : null,
    };
  }
}

// Export singleton instance
export const mouseTrackerService = MouseTrackerService.getInstance();
