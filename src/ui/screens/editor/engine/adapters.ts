import { Application, Sprite, Texture } from 'pixi.js';

import type { FrameContext } from './engine';
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
    ctx.drawImage(this.video, x, y, width, height);
  }
}

export interface MediabunnyVideoSample {
  displayWidth: number;
  displayHeight: number;
  timestamp?: number;
  setTimestamp?(newTimestamp: number): void;
  draw(ctx: Canvas2DContext, x: number, y: number, width: number, height: number): void;
}

export class MediabunnySampleSource implements FrameVideoSource {
  private sample: MediabunnyVideoSample;

  constructor(sample: MediabunnyVideoSample) {
    this.sample = sample;
  }

  draw(ctx: Canvas2DContext, x: number, y: number, width: number, height: number): void {
    this.sample.draw(ctx, x, y, width, height);
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

export function createFrameCanvas(
  width: number,
  height: number,
): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
