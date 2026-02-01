/**
 * NativeRecorderService — Wrapper around velocity N-API addon for native screen recording
 *
 * This service provides:
 * - Native monitor enumeration (replaces desktopCapturer for source selection)
 * - Native screen recording with cursor hidden
 * - Pause/resume support
 *
 * The recording is handled entirely in Rust - no frames are sent to JS.
 */

import { createRequire } from 'module';
import type { VideoCodec as VelocityVideoCodec } from 'velocity';
import type * as Velocity from 'velocity';

// Native .node addons must be loaded via require(), so we use createRequire in ESM
const require = createRequire(import.meta.url);
const velocity = require('velocity') as typeof Velocity;

export interface MonitorSource {
  index: number;
  name: string;
  deviceName: string;
  width: number;
  height: number;
  isPrimary: boolean;
}

/** Video codec for recording (re-exported from velocity) */
export type VideoCodec = VelocityVideoCodec;

export interface NativeRecordingConfig {
  monitorIndex: number;
  outputPath: string;
  frameRate?: number;
  bitrate?: number;
  /** Video codec (default: H264) */
  codec?: VideoCodec;
  /** Output width for resolution scaling (default: native) */
  width?: number;
  /** Output height for resolution scaling (default: native) */
  height?: number;
}

/**
 * Get all available monitors for recording
 */
export function getMonitors(): MonitorSource[] {
  return velocity.getMonitors();
}

/**
 * Get the primary monitor
 */
export function getPrimaryMonitor(): MonitorSource {
  return velocity.getPrimaryMonitor();
}

/**
 * Start a native screen recording
 *
 * @param config Recording configuration
 */
export function startRecording(config: NativeRecordingConfig): void {
  velocity.startRecording(config);
}

/**
 * Stop the current recording
 *
 * @returns The path to the saved video file
 */
export function stopRecording(): string {
  return velocity.stopRecording();
}

/**
 * Pause the current recording (frames will be skipped)
 */
export function pauseRecording(): void {
  velocity.pauseRecording();
}

/**
 * Resume a paused recording
 */
export function resumeRecording(): void {
  velocity.resumeRecording();
}

/**
 * Check if a recording is currently active
 */
export function isRecording(): boolean {
  return velocity.isRecording();
}

/**
 * Check if the recording is paused
 */
export function isPaused(): boolean {
  return velocity.isPaused();
}

// Export as singleton-like module
export const nativeRecorderService = {
  getMonitors,
  getPrimaryMonitor,
  startRecording,
  stopRecording,
  pauseRecording,
  resumeRecording,
  isRecording,
  isPaused,
};
