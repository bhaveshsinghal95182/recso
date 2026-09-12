import type {
  ExportOptions,
  ExportProgress,
  VideoExporterInstance,
} from '../../types/engine.types.js';
import { normaliseExportOptions } from './export-options.js';
import { requireEngineBindings } from './native.js';

/**
 * One engine export at a time.
 *
 * The exporter runs on its own Rust thread with its own decoder, so it does
 * not contend with the player -- but two concurrent exports would fight over
 * the hardware encoder, and there is no reason to want that yet.
 *
 * This is the application's only export implementation. The renderer sends a
 * composition description; this service owns the native exporter instance.
 */
let current: VideoExporterInstance | null = null;
let outputPath: string | null = null;

export function startEngineExport(input: string, options: ExportOptions) {
  if (current && !current.progress().finished) {
    throw new Error('an engine export is already running');
  }

  const { VideoExporter } = requireEngineBindings();

  // Paths de-quoted and pixel buffers turned back into Buffers. See
  // `export-options.ts` for why neither survives the trip from the renderer.
  const normalised = normaliseExportOptions(input, options);

  current = new VideoExporter(normalised.input, normalised.options);
  outputPath = normalised.options.output;

  return { output: outputPath };
}

export function engineExportProgress(): (ExportProgress & { output: string | null }) | null {
  if (!current) {
    return null;
  }
  return { ...current.progress(), output: outputPath };
}

export function cancelEngineExport(): void {
  current?.cancel();
}
