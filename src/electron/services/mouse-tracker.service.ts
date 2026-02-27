/**
 * MouseTrackerService — Global mouse event tracking using uiohook-napi.
 *
 * Dual-mode operation:
 *   • VELOCITY MODE (paid): 60fps, normalized 0-1 coords → velocity.db
 *   • LEGACY MODE (free):   20fps, raw pixel coords → recso.db/mouse_events
 *
 * Mode is determined at startTracking() time by whether monitorBounds are provided.
 * Velocity recordings always provide bounds; legacy WebRTC recordings don't.
 */

import { uIOhook, type UiohookMouseEvent } from 'uiohook-napi';

import { getDatabase } from './database.service.js';
import * as velocityDb from './velocity-database.service.js';

// Mouse event interface (used by consumers — always normalized for Velocity)
export interface MouseEvent {
  id?: number;
  recordingId: string;
  timestampMs: number;
  x: number;
  y: number;
  eventType: 'click' | 'mousemove';
  button?: 'left' | 'right' | 'middle';
}

/** Monitor bounds for coordinate normalization */
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
  private eventBuffer: MouseEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isTracking: boolean = false;
  private monitorBounds: MonitorBounds | null = null;

  /** Whether this session is a Velocity recording (60fps, velocity.db) */
  private velocityMode: boolean = false;

  // Throttle settings — differ by mode
  private lastMoveTime: number = 0;
  private static readonly LEGACY_THROTTLE_MS = 50; // 20fps for free tier
  private static readonly VELOCITY_THROTTLE_MS = 16; // ~60fps for Velocity

  private constructor() {
    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseMove = this.onMouseMove.bind(this);
  }

  static getInstance(): MouseTrackerService {
    if (!MouseTrackerService.instance) {
      MouseTrackerService.instance = new MouseTrackerService();
    }
    return MouseTrackerService.instance;
  }

  /**
   * Start tracking mouse events for a recording.
   *
   * @param recordingId — Unique recording identifier
   * @param monitorBounds — Physical pixel bounds of the recorded monitor.
   *   If provided, enables Velocity mode (60fps, normalized coords, velocity.db).
   *   If omitted, falls back to legacy mode (20fps, raw pixels, main DB).
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
    this.lastMoveTime = 0;

    // Determine mode: Velocity (has bounds) vs Legacy (no bounds)
    this.velocityMode = !!monitorBounds;

    // Register uiohook event listeners
    uIOhook.on('mousedown', this.onMouseDown);
    uIOhook.on('mousemove', this.onMouseMove);

    // Start the hook
    uIOhook.start();

    // Flush timer — slightly faster for Velocity due to higher event volume
    const flushIntervalMs = this.velocityMode ? 1000 : 2000;
    this.flushTimer = setInterval(() => this.flushBuffer(), flushIntervalMs);

    console.log('[MouseTrackerService] Started tracking:', {
      recordingId,
      mode: this.velocityMode ? 'VELOCITY (60fps → velocity.db)' : 'LEGACY (20fps → recso.db)',
      bounds: monitorBounds || 'none',
    });
  }

  /**
   * Handle mouse down events from uiohook
   */
  private onMouseDown(event: UiohookMouseEvent): void {
    if (!this.recordingId || !this.isTracking) return;

    // Map button number to string
    let button: 'left' | 'right' | 'middle' = 'left';
    if (event.button === 2) button = 'right';
    else if (event.button === 3) button = 'middle';

    // Normalize coordinates based on mode
    const { x, y } = this.normalizeCoordinates(event.x, event.y);

    const mouseEvent: MouseEvent = {
      recordingId: this.recordingId,
      timestampMs: Date.now() - this.recordingStartTime,
      x,
      y,
      eventType: 'click',
      button,
    };

    this.eventBuffer.push(mouseEvent);
    console.log('[MouseTrackerService] Click recorded:', {
      raw: { x: event.x, y: event.y },
      normalized: { x, y },
      mode: this.velocityMode ? 'velocity' : 'legacy',
      button,
    });
  }

  /**
   * Handle mouse move events from uiohook (throttled)
   */
  private onMouseMove(event: UiohookMouseEvent): void {
    if (!this.recordingId || !this.isTracking) return;

    const now = Date.now();
    const throttleMs = this.velocityMode
      ? MouseTrackerService.VELOCITY_THROTTLE_MS
      : MouseTrackerService.LEGACY_THROTTLE_MS;

    if (now - this.lastMoveTime < throttleMs) {
      return; // Skip this event due to throttling
    }
    this.lastMoveTime = now;

    // Normalize coordinates based on mode
    const { x, y } = this.normalizeCoordinates(event.x, event.y);

    const mouseEvent: MouseEvent = {
      recordingId: this.recordingId,
      timestampMs: now - this.recordingStartTime,
      x,
      y,
      eventType: 'mousemove',
    };

    this.eventBuffer.push(mouseEvent);
  }

  /**
   * Normalize coordinates based on mode.
   *
   * VELOCITY: Produces 0-1 ratios (subtracts monitor offset, divides by size)
   * LEGACY: Returns raw pixel coordinates (unchanged)
   */
  private normalizeCoordinates(x: number, y: number): { x: number; y: number } {
    if (
      this.velocityMode &&
      this.monitorBounds &&
      this.monitorBounds.width > 0 &&
      this.monitorBounds.height > 0
    ) {
      return {
        x: (x - this.monitorBounds.x) / this.monitorBounds.width,
        y: (y - this.monitorBounds.y) / this.monitorBounds.height,
      };
    }
    return { x, y };
  }

  /**
   * Stop tracking and flush remaining events
   */
  stopTracking(): number {
    if (!this.isTracking) {
      return 0;
    }

    // Remove uiohook event listeners
    uIOhook.off('mousedown', this.onMouseDown);
    uIOhook.off('mousemove', this.onMouseMove);

    // Stop the hook
    uIOhook.stop();

    // Clear timers
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Flush remaining events
    this.flushBuffer();

    const totalEvents = this.getTotalEventCount();

    // Reset state
    this.isTracking = false;
    this.recordingId = null;
    this.monitorBounds = null;
    this.velocityMode = false;

    console.log('[MouseTrackerService] Stopped tracking. Total events:', totalEvents);
    return totalEvents;
  }

  /**
   * Flush event buffer to the appropriate database.
   */
  private flushBuffer(): void {
    if (this.eventBuffer.length === 0) return;

    try {
      if (this.velocityMode) {
        // Write to velocity.db
        velocityDb.insertMouseEvents(this.eventBuffer);
      } else {
        // Write to main recso.db (legacy)
        const db = getDatabase();
        const stmt = db.prepare(`
          INSERT INTO mouse_events (recording_id, timestamp_ms, x, y, event_type, button, meta)
          VALUES (?, ?, ?, ?, ?, ?, NULL)
        `);

        const insertMany = db.transaction((events: MouseEvent[]) => {
          for (const event of events) {
            stmt.run(
              event.recordingId,
              event.timestampMs,
              event.x,
              event.y,
              event.eventType,
              event.button ?? null,
            );
          }
        });

        insertMany(this.eventBuffer);
      }

      console.log(
        `[MouseTrackerService] Flushed ${this.eventBuffer.length} events to ${this.velocityMode ? 'velocity.db' : 'recso.db'}`,
      );
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
      if (this.velocityMode) {
        const events = velocityDb.getEventsForRecording(this.recordingId);
        return events.length + this.eventBuffer.length;
      }

      const db = getDatabase();
      const stmt = db.prepare('SELECT COUNT(*) as count FROM mouse_events WHERE recording_id = ?');
      const result = stmt.get(this.recordingId) as { count: number };
      return result.count + this.eventBuffer.length;
    } catch {
      return this.eventBuffer.length;
    }
  }

  /**
   * Get all events for a recording.
   * Tries velocity.db first, falls back to legacy mouse_events table.
   */
  getEventsForRecording(recordingId: string): MouseEvent[] {
    // Try velocity DB first (premium data)
    try {
      if (velocityDb.hasVelocityData(recordingId)) {
        return velocityDb.getEventsForRecording(recordingId);
      }
    } catch {
      // Velocity DB might not be initialized — fall through to legacy
    }

    // Fallback to legacy mouse_events in main DB
    try {
      const db = getDatabase();
      const stmt = db.prepare(`
        SELECT * FROM mouse_events
        WHERE recording_id = ?
        ORDER BY timestamp_ms ASC
      `);
      const rows = stmt.all(recordingId) as Array<Record<string, unknown>>;

      return rows.map((row) => ({
        id: row.id as number,
        recordingId: row.recording_id as string,
        timestampMs: row.timestamp_ms as number,
        x: row.x as number,
        y: row.y as number,
        eventType: row.event_type as 'click' | 'mousemove',
        button: row.button as 'left' | 'right' | 'middle' | undefined,
      }));
    } catch (error) {
      console.error('[MouseTrackerService] Failed to get events:', error);
      return [];
    }
  }

  /**
   * Check if a recording has Velocity-quality data.
   */
  hasVelocityData(recordingId: string): boolean {
    try {
      return velocityDb.hasVelocityData(recordingId);
    } catch {
      return false;
    }
  }

  /**
   * Delete all events for a recording (both DBs).
   */
  deleteEventsForRecording(recordingId: string): void {
    try {
      velocityDb.deleteEventsForRecording(recordingId);
    } catch {
      // Velocity DB may not be initialized
    }
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
