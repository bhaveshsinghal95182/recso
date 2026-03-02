/**
 * TelemetryService — quick overview:
 * - Generates and persists a hardware-based Support ID in recso.db.
 * - Installs global error handlers for uncaught exceptions and unhandled rejections.
 * - Logs errors to console with the Support ID for correlation.
 *
 * Key exports:
 *   initializeTelemetry()  → Call once at app startup (after database is ready)
 *   getSupportId()         → Returns the persistent support ID
 */

import { app } from 'electron';

import { getDatabase } from '../database.service.js';
import { generateHardwareId } from './hardware-id.js';

let supportId: string | null = null;

/**
 * Initialize the telemetry service.
 * Must be called after initializeDatabase().
 *
 * - Creates the `app_settings` table if it doesn't exist.
 * - Generates and persists the hardware-based support ID.
 * - Installs global error handlers.
 */
export function initializeTelemetry(): void {
  const db = getDatabase();

  // Create key-value settings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Resolve or generate the support ID
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('support_id') as
    | { value: string }
    | undefined;

  if (row) {
    supportId = row.value;
  } else {
    supportId = generateHardwareId();
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('support_id', supportId);
  }

  console.log(`[TelemetryService] Support ID: ${supportId}`);

  // Install global error handlers
  installErrorHandlers();
}

/**
 * Get the persistent support ID for this device.
 * @throws If telemetry has not been initialized yet.
 */
export function getSupportId(): string {
  if (!supportId) {
    throw new Error('Telemetry not initialized. Call initializeTelemetry() first.');
  }
  return supportId;
}

/**
 * Log a renderer-side error, correlating it with the device support ID.
 */
export function logRendererError(error: {
  message: string;
  stack?: string;
  componentStack?: string;
  source?: string;
}): void {
  console.error(`[TelemetryService] Renderer error [${supportId}]:`, {
    ...error,
    appVersion: app.getVersion(),
    timestamp: new Date().toISOString(),
  });

  // TODO: Send to remote endpoint (Supabase / Neon) when ready
  // await fetch('https://your-api.com/errors', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({
  //     supportId,
  //     ...error,
  //     appVersion: app.getVersion(),
  //     platform: process.platform,
  //     timestamp: new Date().toISOString(),
  //   }),
  // });
}

// ─── Internal ────────────────────────────────────────────────────────────────

function installErrorHandlers(): void {
  process.on('uncaughtException', (error) => {
    console.error(`[TelemetryService] Uncaught exception [${supportId}]:`, {
      message: error.message,
      stack: error.stack,
      appVersion: app.getVersion(),
      timestamp: new Date().toISOString(),
    });

    // TODO: Send to remote endpoint when ready
  });

  process.on('unhandledRejection', (reason) => {
    console.error(`[TelemetryService] Unhandled rejection [${supportId}]:`, {
      reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason,
      appVersion: app.getVersion(),
      timestamp: new Date().toISOString(),
    });

    // TODO: Send to remote endpoint when ready
  });
}
