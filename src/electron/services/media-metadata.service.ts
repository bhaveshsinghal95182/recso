import fs from 'fs';

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

/**
 * Probe basic video metadata with MediaBunny.
 *
 * Note: This uses BlobSource and currently reads the file into memory first.
 */
export async function probeVideoMetadata(filePath: string): Promise<VideoMetadata> {
  const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny');

  const fileBuffer = await fs.promises.readFile(filePath);
  const sourceBlob = new Blob([fileBuffer]);

  const input = new Input({
    source: new BlobSource(sourceBlob),
    formats: ALL_FORMATS,
  });

  const [duration, primaryVideoTrack] = await Promise.all([
    input.computeDuration(),
    input.getPrimaryVideoTrack(),
  ]);

  const width = primaryVideoTrack?.displayWidth || primaryVideoTrack?.codedWidth || 1920;
  const height = primaryVideoTrack?.displayHeight || primaryVideoTrack?.codedHeight || 1080;

  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width,
    height,
    // MediaBunny metadata in this flow does not currently expose a guaranteed FPS field.
    fps: 30,
  };
}
