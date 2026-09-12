import { Application, Sprite, Texture } from 'pixi.js';

import type { FrameContext } from './engine';
import { resolveSourceCrop, type SourceCropConfig } from './source-crop';
import { type Canvas2DContext, type FrameVideoSource } from './types';

export class CanvasFrameContext implements FrameContext {
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  width: number;
  height: number;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvas;
    this.width = canvas.width;
    this.height = canvas.height;
  }

  get2DContext(): Canvas2DContext {
    const context = this.canvas.getContext('2d') as Canvas2DContext | null;
    if (!context) {
      throw new Error('Failed to get 2D context.');
    }
    return context;
  }

  getCanvas(): HTMLCanvasElement | OffscreenCanvas {
    return this.canvas;
  }
}

export class HtmlVideoFrameSource implements FrameVideoSource {
  private video: HTMLVideoElement;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  draw(ctx: Canvas2DContext, x: number, y: number, width: number, height: number): void {
    if (this.video.readyState < 2 || this.video.videoWidth <= 0 || this.video.videoHeight <= 0) {
      return;
    }

    ctx.drawImage(this.video, x, y, width, height);
  }
}

/**
 * Draws a cropped region of an HTMLVideoElement.
 * Crop values are normalized 0-1 insets from each edge.
 */
export class CroppedHtmlVideoFrameSource implements FrameVideoSource {
  private video: HTMLVideoElement;
  private cropTop: number;
  private cropLeft: number;
  private cropBottom: number;
  private cropRight: number;

  constructor(video: HTMLVideoElement, crop: SourceCropConfig) {
    this.video = video;
    this.cropTop = crop.top;
    this.cropLeft = crop.left;
    this.cropBottom = crop.bottom;
    this.cropRight = crop.right;
  }

  draw(ctx: Canvas2DContext, x: number, y: number, width: number, height: number): void {
    if (this.video.readyState < 2 || this.video.videoWidth <= 0 || this.video.videoHeight <= 0) {
      return;
    }

    const srcX = this.video.videoWidth * this.cropLeft;
    const srcY = this.video.videoHeight * this.cropTop;
    const srcW = this.video.videoWidth * (1 - this.cropLeft - this.cropRight);
    const srcH = this.video.videoHeight * (1 - this.cropTop - this.cropBottom);

    if (srcW <= 0 || srcH <= 0) {
      return;
    }

    ctx.drawImage(this.video, srcX, srcY, srcW, srcH, x, y, width, height);
  }
}

export function createHtmlVideoFrameSource(
  video: HTMLVideoElement,
  crop?: SourceCropConfig | null,
): FrameVideoSource {
  const resolvedCrop = resolveSourceCrop(crop);
  return resolvedCrop
    ? new CroppedHtmlVideoFrameSource(video, resolvedCrop)
    : new HtmlVideoFrameSource(video);
}

export class HtmlVideoCoverFrameSource implements FrameVideoSource {
  private video: HTMLVideoElement;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  draw(ctx: Canvas2DContext, x: number, y: number, width: number, height: number): void {
    if (this.video.readyState < 2 || this.video.videoWidth <= 0 || this.video.videoHeight <= 0) {
      return;
    }

    const sourceWidth = this.video.videoWidth;
    const sourceHeight = this.video.videoHeight;
    const sourceAspect = sourceWidth / sourceHeight;
    const targetAspect = width / height;

    let cropWidth = sourceWidth;
    let cropHeight = sourceHeight;
    let cropX = 0;
    let cropY = 0;

    // Center-crop source to target aspect ratio to avoid webcam stretching.
    if (sourceAspect > targetAspect) {
      cropWidth = sourceHeight * targetAspect;
      cropX = (sourceWidth - cropWidth) / 2;
    } else if (sourceAspect < targetAspect) {
      cropHeight = sourceWidth / targetAspect;
      cropY = (sourceHeight - cropHeight) / 2;
    }

    ctx.drawImage(this.video, cropX, cropY, cropWidth, cropHeight, x, y, width, height);
  }
}

export class PixiPreviewSurface {
  private app: Application | null = null;
  private texture: Texture | null = null;
  private sprite: Sprite | null = null;
  private sourceCanvas: HTMLCanvasElement | null = null;

  async init(targetCanvas: HTMLCanvasElement, sourceCanvas: HTMLCanvasElement): Promise<void> {
    this.destroy();

    const app = new Application();
    await app.init({
      canvas: targetCanvas,
      width: sourceCanvas.width,
      height: sourceCanvas.height,
      backgroundColor: 0x000000,
    });

    const texture = Texture.from(sourceCanvas);
    const sprite = new Sprite(texture);
    sprite.width = sourceCanvas.width;
    sprite.height = sourceCanvas.height;

    app.stage.addChild(sprite);

    this.app = app;
    this.texture = texture;
    this.sprite = sprite;
    this.sourceCanvas = sourceCanvas;
  }

  present(): void {
    if (!this.texture || !this.app) {
      return;
    }

    this.texture.source.update();
    this.app.render();
  }

  resize(width: number, height: number): void {
    if (!this.app || !this.sprite || !this.sourceCanvas) {
      return;
    }

    this.sourceCanvas.width = width;
    this.sourceCanvas.height = height;
    this.app.renderer.resize(width, height);
    this.sprite.width = width;
    this.sprite.height = height;
  }

  destroy(): void {
    if (this.texture) {
      try {
        this.texture.destroy(true);
      } catch {
        // Ignore teardown errors from already-disposed textures.
      }
    }

    if (this.app) {
      try {
        this.app.destroy(false, { children: true });
      } catch {
        // Ignore teardown errors from already-disposed apps.
      }
    }

    this.texture = null;
    this.sprite = null;
    this.app = null;
    this.sourceCanvas = null;
  }
}
