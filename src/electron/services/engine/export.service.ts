import type {
  ExportOptions,
  ExportProgress,
  VideoExporterInstance,
} from '../../types/engine.types.js';
import { requireEngineBindings } from './native.js';
import { normalizeMediaPath } from './paths.js';

/**
 * One engine export at a time.
 *
 * The exporter runs on its own Rust thread with its own decoder, so it does
 * not contend with the player -- but two concurrent exports would fight over
 * the hardware encoder, and there is no reason to want that yet.
 *
 * This is deliberately separate from recso's mediabunny exporter. Both can be
 * running; they share nothing.
 */
let current: VideoExporterInstance | null = null;
let outputPath: string | null = null;

export function startEngineExport(input: string, options: ExportOptions) {
  if (current && !current.progress().finished) {
    throw new Error('an engine export is already running');
  }

  const { VideoExporter } = requireEngineBindings();
  const output = normalizeMediaPath(options.output);

  current = new VideoExporter(normalizeMediaPath(input), { ...options, output });
  outputPath = output;

  return { output };
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
