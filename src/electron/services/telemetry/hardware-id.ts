/**
 * Hardware ID Generator
 *
 * Generates a deterministic, human-readable support ID from hardware/OS metadata.
 * The same machine will always produce the same ID (survives uninstall/reinstall).
 *
 * Format: XXXX-XXXX-XXXX (12 hex chars, ~281 trillion combinations)
 */

import crypto from 'crypto';
import os from 'os';

/**
 * Generate a deterministic hardware-based support ID.
 * Combines platform, arch, CPU model, hostname, and OS username
 * into a SHA-256 hash, then takes the first 12 hex characters.
 *
 * @returns Formatted ID like "A8F2-9C14-B7D4"
 */
export function generateHardwareId(): string {
  const platform = os.platform();
  const release = os.release();
  const arch = os.arch();
  const cpuModel = os
    .cpus()
    .map((cpu) => cpu.model)
    .join(',');
  const hostname = os.hostname();
  const username = os.userInfo().username;

  const hardwareString = `recso:${platform}:${release}:${arch}:${cpuModel}:${hostname}:${username}`;

  const hash = crypto.createHash('sha256').update(hardwareString).digest('hex');

  // Take first 12 hex characters and format as XXXX-XXXX-XXXX
  const shortHash = hash.substring(0, 12).toUpperCase();
  return `${shortHash.slice(0, 4)}-${shortHash.slice(4, 8)}-${shortHash.slice(8, 12)}`;
}
