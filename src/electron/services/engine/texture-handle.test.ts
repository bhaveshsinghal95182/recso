import { describe, expect, it } from 'vitest';

import type { SharedTextureInfo } from '../../types/engine.types.js';
import { textureHandle } from './texture-handle.js';

const base: SharedTextureInfo = {
  handle: 1234,
  width: 1920,
  height: 1080,
  visibleWidth: 1920,
  visibleHeight: 1080,
  pixelFormat: 'bgra',
  timestamp: 0,
};

describe('textureHandle', () => {
  it('shares a Windows frame by its NT handle', () => {
    const handle = textureHandle(base, (value) => Buffer.from([value & 0xff]));
    expect(handle).toEqual({ ntHandle: Buffer.from([1234 & 0xff]) });
  });

  it('shares a Linux frame as a single-plane native pixmap', () => {
    const handle = textureHandle(
      {
        ...base,
        dmabufFd: 42,
        dmabufStride: 7680,
        dmabufOffset: 0,
        dmabufSize: 7680 * 1080,
        dmabufModifier: '72057594037927936',
      },
      () => {
        throw new Error('no NT handle on Linux');
      },
    );
    expect(handle).toEqual({
      nativePixmap: {
        planes: [{ fd: 42, stride: 7680, offset: 0, size: 7680 * 1080 }],
        modifier: '72057594037927936',
        supportsZeroCopyWebGpuImport: false,
      },
    });
  });

  it('defaults a missing modifier to linear and a missing offset to zero', () => {
    const handle = textureHandle({ ...base, dmabufFd: 3, dmabufStride: 64, dmabufSize: 1024 }, () =>
      Buffer.alloc(0),
    );
    expect(handle).toEqual({
      nativePixmap: {
        planes: [{ fd: 3, stride: 64, offset: 0, size: 1024 }],
        modifier: '0',
        supportsZeroCopyWebGpuImport: false,
      },
    });
  });

  it('refuses a DMA-BUF frame without its layout', () => {
    expect(() => textureHandle({ ...base, dmabufFd: 3 }, () => Buffer.alloc(0))).toThrow(
      'stride or size',
    );
  });
});
