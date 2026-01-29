/**
 * MouseTrackerService — quick overview:
 * - Tracks mouse position at 30 FPS (33ms intervals) during recording
 * - Captures immediate events: clicks, scrolls, drags
 * - Buffers events in memory and flushes to SQLite periodically
 * - Uses @mechakeys/iohook for global mouse hooks
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

import { getDatabase } from './database.service.js';

// Import iohook - will be dynamically imported to avoid issues if not available

let iohook: any = null;

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
   * Initialize iohook - should be called once at app startup
   */
  async initialize(): Promise<void> {
    try {
      const iohookModule = await import('@mechakeys/iohook');
      iohook = iohookModule.default || iohookModule;
      console.log('[MouseTrackerService] iohook initialized');
    } catch (error) {
      console.error('[MouseTrackerService] Failed to initialize iohook:', error);
      // Continue without iohook - will use fallback polling
    }
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

    // Start position sampling timer (30 FPS)
    this.sampleTimer = setInterval(() => this.samplePosition(), SAMPLE_INTERVAL_MS);

    // Start flush timer (every 1 second)
    this.flushTimer = setInterval(() => this.flushBuffer(), FLUSH_INTERVAL_MS);

    // Register global hooks if iohook is available
    if (iohook) {
      this.registerHooks();
    }

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

    // Unregister hooks
    if (iohook) {
      this.unregisterHooks();
    }

    // Flush remaining events
    const eventCount = this.eventBuffer.length;
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
   * Register global mouse hooks
   */
  private registerHooks(): void {
    if (!iohook) return;

    // Mouse click events
    iohook.on('mousedown', (event: { x: number; y: number; button: number }) => {
      this.isMousePressed = true;
      this.recordClickEvent(event, true);
    });

    iohook.on('mouseup', (event: { x: number; y: number; button: number }) => {
      this.isMousePressed = false;
      this.recordClickEvent(event, false);
    });

    // Scroll events
    iohook.on(
      'mousewheel',
      (event: { x: number; y: number; rotation?: number; direction?: number }) => {
        this.recordScrollEvent(event);
      },
    );

    // Start listening
    iohook.start();
  }

  /**
   * Unregister global mouse hooks
   */
  private unregisterHooks(): void {
    if (!iohook) return;

    iohook.stop();
    iohook.removeAllListeners();
  }

  /**
   * Record a click event (bypasses sampling - immediate)
   */
  private recordClickEvent(
    hookEvent: { x: number; y: number; button: number },
    isPressed: boolean,
  ): void {
    if (!this.recordingId) return;

    const button: MouseButton =
      hookEvent.button === 1
        ? 'left'
        : hookEvent.button === 2
          ? 'right'
          : hookEvent.button === 3
            ? 'middle'
            : null;

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
  private recordScrollEvent(hookEvent: {
    x: number;
    y: number;
    rotation?: number;
    direction?: number;
  }): void {
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
        scrollDeltaY: hookEvent.rotation ?? hookEvent.direction ?? 0,
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
