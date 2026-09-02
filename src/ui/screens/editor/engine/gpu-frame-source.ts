/**
 * A `FrameVideoSource` backed by the Rust GPU engine.
 *
 * This is the seam. `HtmlVideoFrameSource` wraps a `<video>` element; this
 * wraps a canvas that preload paints hardware-decoded frames into. Both satisfy
 * the same interface, so the compositor -- background, zoom, cursor, webcam,
 * cuts -- keeps working unchanged either way, and the source of pixels becomes
 * a swappable decision rather than a rewrite.
 *
 * Nothing in the editor uses this yet. It exists so the GPU path can be turned
 * on for one layer at a time instead of all at once. See `docs/ENGINE.md` for
 * what has to be true before it replaces the `<video>` path.
 */

import { resolveSourceCrop, type SourceCropConfig } from './source-crop';
import { type Canvas2DContext, type FrameVideoSource } from './types';

/**
 * The canvas preload paints into.
 *
 * It is a real element in the document rather than an `OffscreenCanvas`
 * because preload has to find it by selector -- DOM nodes cannot cross the
 * contextBridge. It is kept out of the layout entirely; only `drawImage` ever
 * reads it.
 */
export const ENGINE_FRAME_SINK_ID = 'engine-frame-sink';
export const ENGINE_FRAME_SINK_SELECTOR = `#${ENGINE_FRAME_SINK_ID}`;

export class GpuFrameSource implements FrameVideoSource {
  private sink: HTMLCanvasElement;

  constructor(sink: HTMLCanvasElement) {
    this.sink = sink;
  }

  draw(ctx: Canvas2DContext, x: number, y: number, width: number, height: number): void {
    // Zero-sized until the first frame lands. Drawing it then is not an error,
    // but Chromium logs on a zero-width source, and there is nothing to show.
    if (this.sink.width <= 0 || this.sink.height <= 0) {
      return;
    }

    ctx.drawImage(this.sink, x, y, width, height);
  }
}

/**
 * Draws a cropped region of the engine sink.
 *
 * Crop values are normalized 0-1 insets from each edge, matching
 * `CroppedHtmlVideoFrameSource` exactly -- the crop has to behave identically
 * on both paths or switching between them moves the picture.
 */
export class CroppedGpuFrameSource implements FrameVideoSource {
  private sink: HTMLCanvasElement;
  private cropTop: number;
  private cropLeft: number;
  private cropBottom: number;
  private cropRight: number;

  constructor(sink: HTMLCanvasElement, crop: SourceCropConfig) {
    this.sink = sink;
    this.cropTop = crop.top;
    this.cropLeft = crop.left;
    this.cropBottom = crop.bottom;
    this.cropRight = crop.right;
  }

  draw(ctx: Canvas2DContext, x: number, y: number, width: number, height: number): void {
    if (this.sink.width <= 0 || this.sink.height <= 0) {
      return;
    }

    const srcX = this.sink.width * this.cropLeft;
    const srcY = this.sink.height * this.cropTop;
    const srcW = this.sink.width * (1 - this.cropLeft - this.cropRight);
    const srcH = this.sink.height * (1 - this.cropTop - this.cropBottom);

    if (srcW <= 0 || srcH <= 0) {
      return;
    }

    ctx.drawImage(this.sink, srcX, srcY, srcW, srcH, x, y, width, height);
  }
}

export function createGpuFrameSource(
  sink: HTMLCanvasElement,
  crop?: SourceCropConfig | null,
): FrameVideoSource {
  const resolvedCrop = resolveSourceCrop(crop);
  return resolvedCrop ? new CroppedGpuFrameSource(sink, resolvedCrop) : new GpuFrameSource(sink);
}

/**
 * Create the sink element and register it with preload.
 *
 * Kept out of the render tree and out of layout: it is a pixel buffer that
 * happens to be a DOM node, and giving it any visual presence would mean the
 * decoded frame is on screen twice.
 */
export function mountEngineFrameSink(): HTMLCanvasElement | null {
  const existing = document.getElementById(ENGINE_FRAME_SINK_ID);
  if (existing instanceof HTMLCanvasElement) {
    window.electron.engine.bindFrameSink(ENGINE_FRAME_SINK_SELECTOR);
    return existing;
  }

  const canvas = document.createElement('canvas');
  canvas.id = ENGINE_FRAME_SINK_ID;
  canvas.style.display = 'none';
  document.body.appendChild(canvas);

  if (!window.electron.engine.bindFrameSink(ENGINE_FRAME_SINK_SELECTOR)) {
    canvas.remove();
    return null;
  }

  return canvas;
}

export function unmountEngineFrameSink(): void {
  window.electron.engine.unbindFrameSink();
  document.getElementById(ENGINE_FRAME_SINK_ID)?.remove();
}
