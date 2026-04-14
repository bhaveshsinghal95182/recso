import { renderCompositionFrame } from './functions';
import { type Canvas2DContext, type CompositionConfig, type FrameVideoSource } from './types';

export interface FrameContext {
  width: number;
  height: number;
  get2DContext(): Canvas2DContext;
  getCanvas(): HTMLCanvasElement | OffscreenCanvas;
}

export interface TransportState {
  currentTime: number;
  isPlaying: boolean;
  duration: number | null;
}

export class CompositionEngine {
  private config: CompositionConfig;
  private source: FrameVideoSource | null = null;
  private webcamSource: FrameVideoSource | null = null;
  private transport: TransportState = {
    currentTime: 0,
    isPlaying: false,
    duration: null,
  };
  private lastTickMs: number | null = null;

  constructor(initialConfig: CompositionConfig) {
    this.config = initialConfig;
  }

  setComposition(config: CompositionConfig): void {
    this.config = config;
  }

  setVideoSource(source: FrameVideoSource | null): void {
    this.source = source;
  }

  setWebcamSource(source: FrameVideoSource | null): void {
    this.webcamSource = source;
  }

  setDuration(duration: number | null): void {
    if (duration === null) {
      this.transport.duration = null;
      return;
    }

    if (!Number.isFinite(duration) || duration < 0) {
      throw new Error('Duration must be a non-negative finite number or null.');
    }

    this.transport.duration = duration;
    this.transport.currentTime = this.clampTime(this.transport.currentTime);
  }

  play(startTime?: number): number {
    if (typeof startTime === 'number') {
      this.seek(startTime);
    }

    this.transport.isPlaying = true;
    this.lastTickMs = null;
    return this.transport.currentTime;
  }

  pause(): number {
    this.transport.isPlaying = false;
    this.lastTickMs = null;
    return this.transport.currentTime;
  }

  seek(t: number): number {
    this.transport.currentTime = this.clampTime(t);
    this.lastTickMs = null;
    return this.transport.currentTime;
  }

  tick(nowMs: number): number {
    if (!Number.isFinite(nowMs)) {
      return this.transport.currentTime;
    }

    if (!this.transport.isPlaying) {
      this.lastTickMs = nowMs;
      return this.transport.currentTime;
    }

    if (this.lastTickMs === null) {
      this.lastTickMs = nowMs;
      return this.transport.currentTime;
    }

    const elapsedSeconds = Math.max(0, (nowMs - this.lastTickMs) / 1000);
    this.lastTickMs = nowMs;

    this.transport.currentTime = this.clampTime(this.transport.currentTime + elapsedSeconds);

    if (this.transport.duration !== null && this.transport.currentTime >= this.transport.duration) {
      this.transport.isPlaying = false;
      this.lastTickMs = null;
    }

    return this.transport.currentTime;
  }

  getTransportState(): TransportState {
    return {
      currentTime: this.transport.currentTime,
      isPlaying: this.transport.isPlaying,
      duration: this.transport.duration,
    };
  }

  renderCurrentFrame(ctx: FrameContext): void {
    this.renderFrameAt(this.transport.currentTime, ctx);
  }

  renderFrameAt(
    t: number,
    ctx: FrameContext,
    sourceOverride?: FrameVideoSource,
    webcamSourceOverride?: FrameVideoSource | null,
  ): void {
    const source = sourceOverride ?? this.source;
    const webcamSource = webcamSourceOverride ?? this.webcamSource;
    const context2d = ctx.get2DContext();
    const clampedTime = this.clampTime(t);

    if (!source) {
      context2d.clearRect(0, 0, ctx.width, ctx.height);
      return;
    }
    renderCompositionFrame({
      ctx: context2d,
      frameWidth: ctx.width,
      frameHeight: ctx.height,
      t: clampedTime,
      config: this.config,
      source,
      webcamSource,
    });
  }

  dispose(): void {}

  private clampTime(t: number): number {
    const safeTime = Number.isFinite(t) ? Math.max(0, t) : 0;

    if (this.transport.duration === null) {
      return safeTime;
    }

    return Math.min(safeTime, this.transport.duration);
  }
}
