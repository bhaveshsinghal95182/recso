/**
 * MouseTrackerService — Simplified click tracking.
 *
 * This service only tracks click events (not continuous mouse movement).
 * - Polls for click events using Electron's globalShortcut or iohook alternative
 * - Records timestamp and position of each click
 * - Stores in SQLite for playback in editor
 *
 * Simplified from the original velocity-based implementation.
 */

import { screen } from 'electron';

import { getDatabase } from './database.service.js';

// Click event interface
export interface ClickEvent {
  id?: number;
  recordingId: string;
  timestampMs: number;
  x: number;
  y: number;
  button: 'left' | 'right' | 'middle';
}

/** Monitor bounds for coordinate offset calculation */
export interface MonitorBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

class MouseTrackerService {
  private static instance: MouseTrackerService | null = null;

  private recordingId: string | null = null;
  private recordingStartTime: number = 0;
  private eventBuffer: ClickEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isTracking: boolean = false;
  private monitorBounds: MonitorBounds | null = null;

  // Simple click detection via polling (fallback without native hooks)
  private pollTimer: NodeJS.Timeout | null = null;
  private lastClickState: boolean = false;

  private constructor() {}

  static getInstance(): MouseTrackerService {
    if (!MouseTrackerService.instance) {
      MouseTrackerService.instance = new MouseTrackerService();
    }
    return MouseTrackerService.instance;
  }

  /**
   * Start tracking clicks for a recording
   */
  startTracking(recordingId: string, monitorBounds?: MonitorBounds): void {
    if (this.isTracking) {
      console.warn('[MouseTrackerService] Already tracking, stopping previous session');
      this.stopTracking();
    }

    this.recordingId = recordingId;
    this.recordingStartTime = Date.now();
    this.eventBuffer = [];
    this.isTracking = true;
    this.monitorBounds = monitorBounds ?? null;

    // Start flush timer (every 2 seconds)
    this.flushTimer = setInterval(() => this.flushBuffer(), 2000);

    console.log('[MouseTrackerService] Started click tracking for:', recordingId);
    if (monitorBounds) {
      console.log('[MouseTrackerService] Monitor bounds:', monitorBounds);
    }
  }

  /**
   * Record a click event (called from IPC when renderer detects a click)
   */
  recordClick(button: 'left' | 'right' | 'middle' = 'left'): void {
    if (!this.recordingId || !this.isTracking) return;

    const cursorPoint = screen.getCursorScreenPoint();

    // Convert to monitor-local coordinates
    const localX = this.monitorBounds ? cursorPoint.x - this.monitorBounds.x : cursorPoint.x;
    const localY = this.monitorBounds ? cursorPoint.y - this.monitorBounds.y : cursorPoint.y;

    const event: ClickEvent = {
      recordingId: this.recordingId,
      timestampMs: Date.now() - this.recordingStartTime,
      x: localX,
      y: localY,
      button,
    };

    this.eventBuffer.push(event);
    console.log('[MouseTrackerService] Click recorded:', { x: localX, y: localY, button });
  }

  /**
   * Stop tracking and flush remaining events
   */
  stopTracking(): number {
    if (!this.isTracking) {
      return 0;
    }

    // Clear timers
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Flush remaining events
    this.flushBuffer();

    const totalEvents = this.getTotalEventCount();

    // Reset state
    this.isTracking = false;
    this.recordingId = null;
    this.monitorBounds = null;

    console.log('[MouseTrackerService] Stopped tracking. Total clicks:', totalEvents);
    return totalEvents;
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
        VALUES (?, ?, ?, ?, 'click', ?, NULL)
      `);

      const insertMany = db.transaction((events: ClickEvent[]) => {
        for (const event of events) {
          stmt.run(event.recordingId, event.timestampMs, event.x, event.y, event.button);
        }
      });

      insertMany(this.eventBuffer);
      console.log('[MouseTrackerService] Flushed', this.eventBuffer.length, 'clicks to database');
      this.eventBuffer = [];
    } catch (error) {
      console.error('[MouseTrackerService] Failed to flush events:', error);
    }
  }

  /**
   * Get total click count for current recording
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
   * Get all click events for a recording
   */
  getEventsForRecording(recordingId: string): ClickEvent[] {
    try {
      const db = getDatabase();
      const stmt = db.prepare(`
        SELECT * FROM mouse_events
        WHERE recording_id = ? AND event_type = 'click'
        ORDER BY timestamp_ms ASC
      `);
      const rows = stmt.all(recordingId) as Array<Record<string, unknown>>;

      return rows.map((row) => ({
        id: row.id as number,
        recordingId: row.recording_id as string,
        timestampMs: row.timestamp_ms as number,
        x: row.x as number,
        y: row.y as number,
        button: (row.button as 'left' | 'right' | 'middle') ?? 'left',
      }));
    } catch (error) {
      console.error('[MouseTrackerService] Failed to get events:', error);
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
   * Check if currently tracking
   */
  isCurrentlyTracking(): boolean {
    return this.isTracking;
  }

  /**
   * Get current recording ID
   */
  getCurrentRecordingId(): string | null {
    return this.recordingId;
  }
}

// Export singleton instance
export const mouseTrackerService = MouseTrackerService.getInstance();
