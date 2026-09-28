import type { SharedTextureInfo } from '../../types/engine.types.js';

/** The handle half of Electron's `importSharedTexture` options. */
export type TextureHandle =
  | { ntHandle: Buffer }
  | {
      nativePixmap: {
        planes: Array<{ stride: number; offset: number; size: number; fd: number }>;
        modifier: string;
        supportsZeroCopyWebGpuImport: boolean;
      };
    };

/**
 * How a frame is shared depends on the platform that made it.
 *
 * Windows hands over a D3D11 NT handle; Linux hands over a single-plane
 * DMA-BUF, which Electron imports as a `nativePixmap`. The frame says which
 * by whether it carries the `dmabuf*` fields -- the addon sets them only on
 * Linux -- rather than this checking `process.platform`, so a frame can never
 * be imported as the wrong kind.
 */
export function textureHandle(
  info: SharedTextureInfo,
  ntHandle: (handle: number) => Buffer,
): TextureHandle {
  if (info.dmabufFd === undefined) {
    return { ntHandle: ntHandle(info.handle) };
  }

  if (info.dmabufStride === undefined || info.dmabufSize === undefined) {
    throw new Error('a DMA-BUF frame arrived without its stride or size');
  }

  return {
    nativePixmap: {
      planes: [
        {
          fd: info.dmabufFd,
          stride: info.dmabufStride,
          offset: info.dmabufOffset ?? 0,
          size: info.dmabufSize,
        },
      ],
      // DRM_FORMAT_MOD_LINEAR when unspecified.
      modifier: info.dmabufModifier ?? '0',
      // The preview draws frames onto a 2D canvas; nothing imports them into
      // WebGPU, so there is no zero-copy path to promise.
      supportsZeroCopyWebGpuImport: false,
    },
  };
}
