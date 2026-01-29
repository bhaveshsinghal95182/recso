/**
 * DatabaseService — quick overview:
 * - Initializes SQLite with WAL mode at `userData/recso.db` for crash-safe persistence.
 * - Manages `recordings` table with full CRUD: create, read, update status, complete, delete.
 * - Provides `getOrphanedRecordings()` for crash recovery (finds incomplete recordings).
 *
 * Key exports:
 *   initializeDatabase()      → Call once at app startup
 *   createRecording()         → Insert new recording metadata
 *   updateRecordingStatus()   → Update status (recording/paused/orphaned/failed)
 *   completeRecording()       → Mark complete with final path
 *   getRecording()            → Get by ID
 *   getOrphanedRecordings()   → Find incomplete recordings
 *   deleteRecording()         → Remove entry
 *   closeDatabase()           → Clean shutdown
 */

import { app } from 'electron';

import Database from 'better-sqlite3';
import path from 'path';

import type { RecordingMetadata, RecordingStatus } from '../types/recorder.types.js';

let db: Database.Database | null = null;

/**
 * Initialize the database and create tables
 * Should be called once at app startup
 */
export function initializeDatabase(): void {
  const dbPath = path.join(app.getPath('userData'), 'recso.db');

  db = new Database(dbPath);

  // Enable WAL mode for crash safety
  db.pragma('journal_mode = WAL');

  // Create recordings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'recording',
      temp_path TEXT NOT NULL,
      final_path TEXT,
      output_dir TEXT NOT NULL,
      file_name TEXT NOT NULL,
      source_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      stopped_at INTEGER,
      window_bounds TEXT
    )
  `);

  // Create mouse_events table for mouse path tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS mouse_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      button TEXT,
      meta TEXT,
      FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
    )
  `);

  // Create index for efficient querying by recording and time
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mouse_recording ON mouse_events(recording_id, timestamp_ms)
  `);

  console.log('[DatabaseService] Initialized at:', dbPath);
}

/**
 * Get the database instance
 */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

/**
 * Create a new recording entry
 */
export function createRecording(metadata: Omit<RecordingMetadata, 'stoppedAt'>): void {
  const database = getDatabase();

  const stmt = database.prepare(`
    INSERT INTO recordings (id, status, temp_path, final_path, output_dir, file_name, source_id, started_at, window_bounds)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    metadata.id,
    metadata.status,
    metadata.tempPath,
    metadata.finalPath,
    metadata.outputDir,
    metadata.fileName,
    metadata.sourceId,
    metadata.startedAt,
    metadata.windowBounds ? JSON.stringify(metadata.windowBounds) : null,
  );
}

/**
 * Update recording status
 */
export function updateRecordingStatus(id: string, status: RecordingStatus): void {
  const database = getDatabase();
  const stmt = database.prepare('UPDATE recordings SET status = ? WHERE id = ?');
  stmt.run(status, id);
}

/**
 * Mark recording as completed with final path
 */
export function completeRecording(id: string, finalPath: string): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    UPDATE recordings SET status = 'completed', final_path = ?, stopped_at = ? WHERE id = ?
  `);
  stmt.run(finalPath, Date.now(), id);
}

/**
 * Get recording by ID
 */
export function getRecording(id: string): RecordingMetadata | null {
  const database = getDatabase();
  const stmt = database.prepare('SELECT * FROM recordings WHERE id = ?');
  const row = stmt.get(id) as Record<string, unknown> | undefined;

  if (!row) return null;

  return mapRowToMetadata(row);
}

/**
 * Get all orphaned recordings (status is not 'completed' or 'failed')
 */
export function getOrphanedRecordings(): RecordingMetadata[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM recordings WHERE status NOT IN ('completed', 'failed')
  `);
  const rows = stmt.all() as Record<string, unknown>[];

  return rows.map(mapRowToMetadata);
}

/**
 * Delete a recording entry
 */
export function deleteRecording(id: string): void {
  const database = getDatabase();
  const stmt = database.prepare('DELETE FROM recordings WHERE id = ?');
  stmt.run(id);
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Helper to map DB row to RecordingMetadata
function mapRowToMetadata(row: Record<string, unknown>): RecordingMetadata {
  return {
    id: row.id as string,
    status: row.status as RecordingStatus,
    tempPath: row.temp_path as string,
    finalPath: (row.final_path as string) || null,
    outputDir: row.output_dir as string,
    fileName: row.file_name as string,
    sourceId: row.source_id as string,
    startedAt: row.started_at as number,
    stoppedAt: (row.stopped_at as number) || null,
    windowBounds: row.window_bounds ? JSON.parse(row.window_bounds as string) : null,
  };
}
