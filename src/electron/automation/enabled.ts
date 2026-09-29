/**
 * Whether the Automation API should be listening, and the little it keeps.
 *
 * Off unless the user turned it on in Settings, which is stored in
 * `automation-settings.json` next to recso's other data. `RECSO_AUTOMATION`
 * overrides the stored choice either way, for development and tests. The same
 * file keeps the portal's restore token for `rememberSource` recordings.
 */

import fs from 'node:fs';
import path from 'node:path';

export const AUTOMATION_SETTINGS_FILE = 'automation-settings.json';

interface StoredAutomationSettings {
  enabled?: boolean;
  portalRestoreToken?: string | null;
}

export function automationEnabled(
  env: Record<string, string | undefined>,
  storedEnabled: boolean,
): boolean {
  const value = env.RECSO_AUTOMATION?.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'off') return false;
  return storedEnabled;
}

function readStored(userDataDir: string): StoredAutomationSettings {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(userDataDir, AUTOMATION_SETTINGS_FILE), 'utf8'),
    ) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as StoredAutomationSettings) : {};
  } catch {
    return {};
  }
}

function writeStored(userDataDir: string, patch: StoredAutomationSettings): void {
  const next = { ...readStored(userDataDir), ...patch };
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, AUTOMATION_SETTINGS_FILE),
    `${JSON.stringify(next, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/** The stored toggle; anything missing or unreadable means off. */
export function readStoredEnabled(userDataDir: string): boolean {
  return readStored(userDataDir).enabled === true;
}

export function writeStoredEnabled(userDataDir: string, enabled: boolean): void {
  writeStored(userDataDir, { enabled });
}

export function readStoredRestoreToken(userDataDir: string): string | null {
  const token = readStored(userDataDir).portalRestoreToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export function writeStoredRestoreToken(userDataDir: string, token: string | null): void {
  writeStored(userDataDir, { portalRestoreToken: token });
}
