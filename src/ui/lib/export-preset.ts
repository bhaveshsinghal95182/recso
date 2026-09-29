/**
 * The Automation API's export presets, such as `1080p-high`, as the export
 * dialog's resolution and quality. The API validates presets before starting
 * an export, so anything unrecognised here falls back to the headless
 * export's long-standing default.
 */

import type { ExportQuality, ExportResolution } from '@/types';

const PRESET = /^(720p|1080p|4k)-(low|medium|high|lossless)$/;

export function parseExportPreset(preset: string | undefined): [ExportResolution, ExportQuality] {
  const match = preset ? PRESET.exec(preset) : null;
  if (!match) return ['1080p', 'high'];
  return [match[1] as ExportResolution, match[2] as ExportQuality];
}
