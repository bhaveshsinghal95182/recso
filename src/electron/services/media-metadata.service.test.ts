import { beforeEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({
  info: vi.fn(),
  VideoDecoder: vi.fn(),
}));

vi.mock('./engine/native.js', () => ({
  requireEngineBindings: () => ({ VideoDecoder: engine.VideoDecoder }),
}));

vi.mock('./engine/paths.js', () => ({
  normalizeMediaPath: (path: string) => path.replaceAll('"', ''),
}));

import { probeVideoMetadata } from './media-metadata.service.js';

describe('probeVideoMetadata', () => {
  beforeEach(() => {
    engine.info.mockReset();
    engine.VideoDecoder.mockReset();
    engine.VideoDecoder.mockImplementation(function VideoDecoder() {
      return { info: engine.info };
    });
  });

  it('uses the native decoder metadata without reading the recording into JavaScript memory', async () => {
    engine.info.mockReturnValue({
      duration: 12_500,
      width: 2560,
      height: 1440,
      codedWidth: 2560,
      codedHeight: 1440,
      fps: 60,
    });

    await expect(probeVideoMetadata('"C:\\takes\\large.mp4"')).resolves.toEqual({
      duration: 12.5,
      width: 2560,
      height: 1440,
      fps: 60,
    });
    expect(engine.VideoDecoder).toHaveBeenCalledWith('C:\\takes\\large.mp4');
    expect(engine.info).toHaveBeenCalledOnce();
  });

  it('keeps safe metadata defaults for incomplete container metadata', async () => {
    engine.info.mockReturnValue({
      duration: Number.NaN,
      width: 0,
      height: 0,
      codedWidth: 1280,
      codedHeight: 720,
      fps: 0,
    });

    await expect(probeVideoMetadata('C:\\takes\\recovering.mp4')).resolves.toEqual({
      duration: 0,
      width: 1280,
      height: 720,
      fps: 30,
    });
  });
});
