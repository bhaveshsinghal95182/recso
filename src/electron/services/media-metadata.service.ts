import { requireEngineBindings } from './engine/native.js';
import { normalizeMediaPath } from './engine/paths.js';

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

/**
 * Probe basic video metadata through the same native decoder used by preview
 * and export. Opening the decoder reads container metadata without loading the
 * recording into renderer or main-process memory.
 */
export async function probeVideoMetadata(filePath: string): Promise<VideoMetadata> {
  const decoder = new (requireEngineBindings().VideoDecoder)(normalizeMediaPath(filePath));
  const info = decoder.info();

  return {
    duration: Number.isFinite(info.duration) ? info.duration / 1000 : 0,
    width: info.width || info.codedWidth || 1920,
    height: info.height || info.codedHeight || 1080,
    fps: Number.isFinite(info.fps) && info.fps > 0 ? info.fps : 30,
  };
}
