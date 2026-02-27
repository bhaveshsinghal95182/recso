/**
 * VelocityDatabaseService — Separate SQLite database for Velocity premium features.
 *
 * Stores high-fidelity mouse tracking data (60fps, normalized 0-1 coordinates)
 * independently from the main app database. This separation enables:
 *   1. Backward compatibility — legacy mouse_events table untouched
 *   2. Feature gating — Velocity DB only exists for paid/Velocity recordings
 *   3. Higher fidelity — 60fps sampling for smoother cursor overlays
 *
 * Database file:  {userData}/velocity.db
 *
 * Tables:
 *   velocity_mouse_events  — 60fps normalized mouse positions + clicks
 *   velocity_metadata      — per-recording capture context (monitor, DPI, etc.)
 */

import { app } from 'electron';

import Database from 'better-sqlite3';
import path from 'path';

let db: Database.Database | null = null;

// ─── Types ───────────────────────────────────────────────────────────────

export interface VelocityMouseEvent {
  id?: number;
  recordingId: string;
  timestampMs: number;
  /** Normalized X position (0.0 = left edge, 1.0 = right edge) */
  x: number;
  /** Normalized Y position (0.0 = top edge, 1.0 = bottom edge) */
  y: number;
  eventType: 'click' | 'mousemove';
  button?: 'left' | 'right' | 'middle';
}

export interface VelocityRecordingMetadata {
  recordingId: string;
  /** Physical monitor width at capture time (pixels) */
  monitorWidth: number;
  /** Physical monitor height at capture time (pixels) */
  monitorHeight: number;
  /** DPI scale factor at capture time */
  scaleFactor: number;
  /** Capture FPS for mouse events */
  captureFps: number;
  /** What was being captured */
  captureSource: 'monitor' | 'window';
  /** Window title if capturing a specific window */
  windowTitle?: string;
}

// ─── Initialization ──────────────────────────────────────────────────────

/**
 * Initialize the Velocity database.
 * Creates the DB file and tables if they don't exist.
 * Should be called once at app startup alongside the main DB init.
 */
export function initializeVelocityDatabase(): void {
  const dbPath = path.join(app.getPath('userData'), 'velocity.db');

  db = new Database(dbPath);

  // Enable WAL mode for crash safety + concurrent reads during recording
  db.pragma('journal_mode = WAL');

  // Mouse events table — 60fps normalized coordinates
  db.exec(`
    CREATE TABLE IF NOT EXISTS velocity_mouse_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id TEXT NOT NULL,
      timestamp_ms REAL NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      event_type TEXT NOT NULL,
      button TEXT
    )
  `);

  // Index for efficient querying by recording + time
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vel_mouse_recording
    ON velocity_mouse_events(recording_id, timestamp_ms)
  `);

  // Recording metadata — capture context preserved for later use
  db.exec(`
    CREATE TABLE IF NOT EXISTS velocity_metadata (
      recording_id TEXT PRIMARY KEY,
      monitor_width INTEGER NOT NULL,
      monitor_height INTEGER NOT NULL,
      scale_factor REAL NOT NULL,
      capture_fps INTEGER NOT NULL DEFAULT 60,
      capture_source TEXT NOT NULL DEFAULT 'monitor',
      window_title TEXT
    )
  `);

  console.log('[VelocityDB] Initialized at:', dbPath);
}

// ─── Database Access ─────────────────────────────────────────────────────

/**
 * Get the Velocity database instance.
 */
export function getVelocityDatabase(): Database.Database {
  if (!db) {
    throw new Error('Velocity database not initialized. Call initializeVelocityDatabase() first.');
  }
  return db;
}

// ─── Mouse Events ────────────────────────────────────────────────────────

/**
 * Insert mouse events in batch (called from the flush timer).
 */
export function insertMouseEvents(events: VelocityMouseEvent[]): void {
  if (events.length === 0) return;

  const database = getVelocityDatabase();
  const stmt = database.prepare(`
    INSERT INTO velocity_mouse_events (recording_id, timestamp_ms, x, y, event_type, button)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = database.transaction((batch: VelocityMouseEvent[]) => {
    for (const event of batch) {
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

  insertMany(events);
}

/**
 * Get all mouse events for a recording, sorted by timestamp.
 */
export function getEventsForRecording(recordingId: string): VelocityMouseEvent[] {
  const database = getVelocityDatabase();
  const stmt = database.prepare(`
    SELECT * FROM velocity_mouse_events
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
}

/**
 * Check if a recording has velocity mouse data.
 */
export function hasVelocityData(recordingId: string): boolean {
  const database = getVelocityDatabase();
  const stmt = database.prepare(
    'SELECT COUNT(*) as count FROM velocity_mouse_events WHERE recording_id = ?',
  );
  const result = stmt.get(recordingId) as { count: number };
  return result.count > 0;
}

/**
 * Delete all events for a recording.
 */
export function deleteEventsForRecording(recordingId: string): void {
  const database = getVelocityDatabase();
  database.prepare('DELETE FROM velocity_mouse_events WHERE recording_id = ?').run(recordingId);
  database.prepare('DELETE FROM velocity_metadata WHERE recording_id = ?').run(recordingId);
}

// ─── Metadata ────────────────────────────────────────────────────────────

/**
 * Save recording metadata (capture context).
 */
export function saveMetadata(metadata: VelocityRecordingMetadata): void {
  const database = getVelocityDatabase();
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO velocity_metadata
    (recording_id, monitor_width, monitor_height, scale_factor, capture_fps, capture_source, window_title)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    metadata.recordingId,
    metadata.monitorWidth,
    metadata.monitorHeight,
    metadata.scaleFactor,
    metadata.captureFps,
    metadata.captureSource,
    metadata.windowTitle ?? null,
  );
}

/**
 * Get recording metadata.
 */
export function getMetadata(recordingId: string): VelocityRecordingMetadata | null {
  const database = getVelocityDatabase();
  const stmt = database.prepare('SELECT * FROM velocity_metadata WHERE recording_id = ?');
  const row = stmt.get(recordingId) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    recordingId: row.recording_id as string,
    monitorWidth: row.monitor_width as number,
    monitorHeight: row.monitor_height as number,
    scaleFactor: row.scale_factor as number,
    captureFps: row.capture_fps as number,
    captureSource: row.capture_source as 'monitor' | 'window',
    windowTitle: row.window_title as string | undefined,
  };
}

// ─── Cleanup ─────────────────────────────────────────────────────────────

/**
 * Close the Velocity database connection.
 */
export function closeVelocityDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
