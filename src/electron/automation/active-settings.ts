/**
 * The settings store while the Automation API is on, for the few places
 * outside it that honour API settings (the export dialog's default folder).
 *
 * Null whenever the API is off, so those places behave exactly as before.
 * Its own module so they can import it without pulling in the API.
 */

import type { SettingsStore } from './settings-store.js';

let current: SettingsStore | null = null;

export function activeSettings(): SettingsStore | null {
  return current;
}

export function setActiveSettings(store: SettingsStore | null): void {
  current = store;
}
