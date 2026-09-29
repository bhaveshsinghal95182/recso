/**
 * MouseTrackerService — Global mouse event tracking using uiohook-napi.
 *
 * This service tracks click and movement events using native input hooks.
 * - Uses uiohook-napi for cross-platform global input hooks
 * - Records timestamp and position of each click and movement
 * - Stores in SQLite for playback in editor
 */

import { createRequire } from 'node:module';

import { app } from 'electron';

import fs from 'fs';
import path from 'path';
import { uIOhook, type UiohookMouseEvent } from 'uiohook-napi';

import { getDatabase } from './database.service.js';
import { type HyprlandClickCapture, startHyprlandClickCapture } from './hyprland-clicks.js';

const require = createRequire(import.meta.url);

interface VelocityCursorBindings {
  captureCursorSnapshotJson?: () => string;
}

let velocityCursorBindingsCache: VelocityCursorBindings | null | undefined;

function getVelocityCursorBindings(): VelocityCursorBindings | null {
  if (velocityCursorBindingsCache !== undefined) {
    return velocityCursorBindingsCache;
  }

  const candidatePaths = [
    path.resolve(process.cwd(), 'velocity', 'index.js'),
    path.resolve(app.getAppPath(), 'velocity', 'index.js'),
    path.resolve(app.getAppPath(), '..', 'velocity', 'index.js'),
    path.resolve(process.resourcesPath, 'velocity', 'index.js'),
    path.resolve(process.resourcesPath, 'app.asar.unpacked', 'velocity', 'index.js'),
  ];

  for (const candidatePath of candidatePaths) {
    if (!fs.existsSync(candidatePath)) {
      continue;
    }

    try {
      velocityCursorBindingsCache = require(candidatePath) as VelocityCursorBindings;
      return velocityCursorBindingsCache;
    } catch {
      // Try the next candidate path.
    }
  }

  velocityCursorBindingsCache = null;
  return velocityCursorBindingsCache;
}

/** The cursor's global position from velocity's snapshot, if it has one. */
function readVelocityCursorPosition(): { x: number; y: number } | null {
  const velocity = getVelocityCursorBindings();
  if (!velocity?.captureCursorSnapshotJson) {
    return null;
  }
  try {
    const snapshot = asRecord(JSON.parse(velocity.captureCursorSnapshotJson()));
    const screenPos = asRecord(asRecord(snapshot?.cursorInfo)?.screenPos);
    const x = toFiniteOrUndefined(screenPos?.x);
    const y = toFiniteOrUndefined(screenPos?.y);
    return x === undefined || y === undefined ? null : { x, y };
  } catch {
    return null;
  }
}

// Mouse event interface
export interface MouseEvent {
  id?: number;
  recordingId: string;
  timestampMs: number;
  x: number;
  y: number;
  normalizedX?: number;
  normalizedY?: number;
  cursorDataUrl?: string;
  cursorHotspotX?: number;
  cursorHotspotY?: number;
  cursorHandleHex?: string;
  eventType: 'click' | 'mousemove';
  button?: 'left' | 'right' | 'middle';
}

interface MouseEventMeta {
  normalizedX?: number;
  normalizedY?: number;
  cursorDataUrl?: string;
  cursorHotspotX?: number;
  cursorHotspotY?: number;
  cursorHandleHex?: string;
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
  private eventBuffer: MouseEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastPolledPosition: { x: number; y: number } | null = null;
  private clickCapture: HyprlandClickCapture | null = null;
  private drainingClicks = false;
  private isTracking: boolean = false;
  private monitorBounds: MonitorBounds | null = null;

  // Throttle mouse movement events (capture at most every N ms)
  private lastMoveTime: number = 0;
  private readonly moveThrottleMs: number = 50; // 20 events per second max

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
   * Start tracking mouse events for a recording
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

    // Register uiohook event listeners
    uIOhook.on('mousedown', this.onMouseDown);
    uIOhook.on('mousemove', this.onMouseMove);

    // Start the hook
    uIOhook.start();

    // Wayland gives the X11 hook no events for native windows, so on Linux
    // the position is polled from velocity instead (Hyprland's IPC).
    if (process.platform === 'linux') {
      this.lastPolledPosition = null;
      this.pollTimer = setInterval(() => this.pollCursorPosition(), this.moveThrottleMs);
      // Nor any clicks, which auto zoom is built from. Hyprland can report
      // them through binds that let every click through.
      void startHyprlandClickCapture().then((capture) => {
        if (this.isTracking && this.recordingId === recordingId && !this.clickCapture) {
          this.clickCapture = capture;
        } else {
          void capture?.stop();
        }
      });
    }

    // Start flush timer (every 2 seconds)
    this.flushTimer = setInterval(() => this.flushBuffer(), 2000);

    console.log('[MouseTrackerService] Started mouse tracking for:', recordingId);
    if (monitorBounds) {
      console.log('[MouseTrackerService] Monitor bounds:', monitorBounds);
    }
  }

  /**
   * Handle mouse down events from uiohook
   */
  private onMouseDown(event: UiohookMouseEvent): void {
    // Hyprland reports every click, including the XWayland ones this hook
    // also sees; taking both would record those twice.
    if (this.clickCapture) return;

    // Map button number to string
    let button: 'left' | 'right' | 'middle' = 'left';
    if (event.button === 2) button = 'right';
    else if (event.button === 3) button = 'middle';

    this.recordClick(event.x, event.y, button, Date.now());
  }

  /** A click from any source, at the wall-clock time it happened. */
  private recordClick(
    screenX: number,
    screenY: number,
    button: 'left' | 'right' | 'middle',
    atEpochMs: number,
  ): void {
    if (!this.recordingId || !this.isTracking) return;

    const { x, y, normalizedX, normalizedY } = this.normalizeCoordinates(screenX, screenY);
    const cursorSnapshot = this.captureCursorVisualMeta();

    const mouseEvent: MouseEvent = {
      recordingId: this.recordingId,
      timestampMs: Math.max(0, atEpochMs - this.recordingStartTime),
      x,
      y,
      normalizedX,
      normalizedY,
      ...cursorSnapshot,
      eventType: 'click',
      button,
    };

    this.eventBuffer.push(mouseEvent);
    console.log('[MouseTrackerService] Click recorded:', { x, y, button });
  }

  /**
   * Handle mouse move events from uiohook (throttled)
   */
  private onMouseMove(event: UiohookMouseEvent): void {
    if (!this.recordingId || !this.isTracking) return;

    const now = Date.now();
    if (now - this.lastMoveTime < this.moveThrottleMs) {
      return; // Skip this event due to throttling
    }
    this.lastMoveTime = now;

    const { x, y, normalizedX, normalizedY } = this.normalizeCoordinates(event.x, event.y);
    const cursorSnapshot = this.captureCursorVisualMeta();

    const mouseEvent: MouseEvent = {
      recordingId: this.recordingId,
      timestampMs: now - this.recordingStartTime,
      x,
      y,
      normalizedX,
      normalizedY,
      ...cursorSnapshot,
      eventType: 'mousemove',
    };

    this.eventBuffer.push(mouseEvent);
  }

  /**
   * Feed a polled cursor position through the same path as a hook event.
   *
   * Only a position that changed becomes an event: the hook reports movement,
   * and a sampler that also reported stillness would fill the table with
   * copies of the last position.
   */
  private pollCursorPosition(): void {
    this.drainClicks();
    const position = readVelocityCursorPosition();
    if (!position) {
      return;
    }
    const last = this.lastPolledPosition;
    if (last && last.x === position.x && last.y === position.y) {
      return;
    }
    this.lastPolledPosition = position;
    this.onMouseMove(position as UiohookMouseEvent);
  }

  /** Hyprland's clicks since the last poll. One drain at a time: each is a socket round trip. */
  private drainClicks(): void {
    const capture = this.clickCapture;
    if (!capture || this.drainingClicks) {
      return;
    }
    this.drainingClicks = true;
    void capture
      .drain()
      .then((clicks) => {
        for (const click of clicks) {
          this.recordClick(click.x, click.y, click.button, click.atEpochMs);
        }
      })
      .finally(() => {
        this.drainingClicks = false;
      });
  }

  private captureCursorVisualMeta(): Pick<
    MouseEvent,
    'cursorDataUrl' | 'cursorHotspotX' | 'cursorHotspotY' | 'cursorHandleHex'
  > {
    const velocity = getVelocityCursorBindings();
    if (!velocity?.captureCursorSnapshotJson) {
      return {};
    }

    try {
      const rawSnapshot = velocity.captureCursorSnapshotJson();
      const snapshot = asRecord(JSON.parse(rawSnapshot));
      const cursorInfo = asRecord(snapshot?.cursorInfo);
      const cursorImage = asRecord(cursorInfo?.cursorImage);

      return {
        cursorDataUrl: toStringOrUndefined(cursorImage?.dataUrl),
        cursorHotspotX: toFiniteOrUndefined(cursorImage?.hotspotX),
        cursorHotspotY: toFiniteOrUndefined(cursorImage?.hotspotY),
        cursorHandleHex: toStringOrUndefined(cursorInfo?.hCursorHex),
      };
    } catch {
      return {};
    }
  }

  /**
   * Convert global coordinates to monitor-local pixels and optional 0..1 normalized values.
   */
  private normalizeCoordinates(
    x: number,
    y: number,
  ): { x: number; y: number; normalizedX?: number; normalizedY?: number } {
    if (this.monitorBounds) {
      const localX = x - this.monitorBounds.x;
      const localY = y - this.monitorBounds.y;
      const hasValidSize = this.monitorBounds.width > 0 && this.monitorBounds.height > 0;

      return {
        x: localX,
        y: localY,
        normalizedX: hasValidSize ? clampUnit(localX / this.monitorBounds.width) : undefined,
        normalizedY: hasValidSize ? clampUnit(localY / this.monitorBounds.height) : undefined,
      };
    }
    return { x, y };
  }

  private serialiseEventMeta(event: MouseEvent): string | null {
    const payload: MouseEventMeta = {};

    const normalizedX = toFiniteOrUndefined(event.normalizedX);
    const normalizedY = toFiniteOrUndefined(event.normalizedY);
    const cursorHotspotX = toFiniteOrUndefined(event.cursorHotspotX);
    const cursorHotspotY = toFiniteOrUndefined(event.cursorHotspotY);
    const cursorDataUrl = toStringOrUndefined(event.cursorDataUrl);
    const cursorHandleHex = toStringOrUndefined(event.cursorHandleHex);

    if (normalizedX !== undefined) {
      payload.normalizedX = normalizedX;
    }

    if (normalizedY !== undefined) {
      payload.normalizedY = normalizedY;
    }

    if (cursorDataUrl) {
      payload.cursorDataUrl = cursorDataUrl;
    }

    if (cursorHotspotX !== undefined) {
      payload.cursorHotspotX = cursorHotspotX;
    }

    if (cursorHotspotY !== undefined) {
      payload.cursorHotspotY = cursorHotspotY;
    }

    if (cursorHandleHex) {
      payload.cursorHandleHex = cursorHandleHex;
    }

    if (Object.keys(payload).length === 0) {
      return null;
    }

    return JSON.stringify(payload);
  }

  private parseEventMeta(rawMeta: unknown): MouseEventMeta {
    if (typeof rawMeta !== 'string' || rawMeta.trim().length === 0) {
      return {};
    }

    try {
      const parsed = JSON.parse(rawMeta) as Record<string, unknown>;
      return {
        normalizedX: toFiniteOrUndefined(parsed.normalizedX),
        normalizedY: toFiniteOrUndefined(parsed.normalizedY),
        cursorDataUrl: toStringOrUndefined(parsed.cursorDataUrl),
        cursorHotspotX: toFiniteOrUndefined(parsed.cursorHotspotX),
        cursorHotspotY: toFiniteOrUndefined(parsed.cursorHotspotY),
        cursorHandleHex: toStringOrUndefined(parsed.cursorHandleHex),
      };
    } catch {
      return {};
    }
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
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    void this.clickCapture?.stop();
    this.clickCapture = null;
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

    console.log('[MouseTrackerService] Stopped tracking. Total events:', totalEvents);
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
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const insertMany = db.transaction((events: MouseEvent[]) => {
        for (const event of events) {
          const meta = this.serialiseEventMeta(event);
          stmt.run(
            event.recordingId,
            event.timestampMs,
            event.x,
            event.y,
            event.eventType,
            event.button ?? null,
            meta,
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

      return rows.map((row) => {
        const meta = this.parseEventMeta(row.meta);
        return {
          id: row.id as number,
          recordingId: row.recording_id as string,
          timestampMs: row.timestamp_ms as number,
          x: row.x as number,
          y: row.y as number,
          normalizedX: meta.normalizedX,
          normalizedY: meta.normalizedY,
          cursorDataUrl: meta.cursorDataUrl,
          cursorHotspotX: meta.cursorHotspotX,
          cursorHotspotY: meta.cursorHotspotY,
          cursorHandleHex: meta.cursorHandleHex,
          eventType: row.event_type as 'click' | 'mousemove',
          button: row.button as 'left' | 'right' | 'middle' | undefined,
        };
      });
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

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function toFiniteOrUndefined(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

// Export singleton instance
export const mouseTrackerService = MouseTrackerService.getInstance();
