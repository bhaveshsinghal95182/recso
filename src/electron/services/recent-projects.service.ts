/**
 * RecentProjectsService — Manages the recent projects list for the welcome screen.
 *
 * Key exports:
 *   upsertRecentProject()   → Insert or update (by path) a recent project entry
 *   getRecentProjects()     → Get N most recently opened projects
 *   removeRecentProject()   → Remove a single entry by ID
 *   clearRecentProjects()   → Remove all entries
 */

import path from 'node:path';

import { getDatabase } from './database.service.js';

export interface RecentProjectRow {
  id: string;
  name: string;
  path: string;
  recordingId: string;
  thumbnail: string | null;
  openedAt: number;
  createdAt: number;
}

/**
 * Insert or update a recent project entry.
 * On conflict (same path), updates opened_at and name.
 */
export function upsertRecentProject(entry: {
  id: string;
  name: string;
  path: string;
  recordingId: string;
  thumbnail?: string | null;
}): void {
  const db = getDatabase();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO recent_projects (id, name, path, recording_id, thumbnail, opened_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      name = excluded.name,
      recording_id = excluded.recording_id,
      opened_at = excluded.opened_at
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      path = excluded.path,
      recording_id = excluded.recording_id,
      opened_at = excluded.opened_at
  `);

  stmt.run(
    entry.id,
    entry.name,
    path.resolve(entry.path),
    entry.recordingId,
    entry.thumbnail ?? null,
    now,
    now,
  );
}

/**
 * Get the most recently opened projects, ordered by opened_at DESC.
 */
export function getRecentProjects(limit: number = 10): RecentProjectRow[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM recent_projects ORDER BY opened_at DESC LIMIT ?
  `);

  const rows = stmt.all(limit) as Record<string, unknown>[];
  return rows.map(mapRowToRecentProject);
}

/**
 * Remove a single recent project entry by ID.
 */
export function removeRecentProject(id: string): boolean {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM recent_projects WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Remove all recent project entries.
 */
export function clearRecentProjects(): boolean {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM recent_projects');
  stmt.run();
  return true;
}

// Helper to map a DB row to the typed interface
function mapRowToRecentProject(row: Record<string, unknown>): RecentProjectRow {
  return {
    id: row.id as string,
    name: row.name as string,
    path: row.path as string,
    recordingId: row.recording_id as string,
    thumbnail: (row.thumbnail as string) || null,
    openedAt: row.opened_at as number,
    createdAt: row.created_at as number,
  };
}
