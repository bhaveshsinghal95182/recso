/**
 * FFmpeg Service
 *
 * Centralized service for FFmpeg operations.
 * Responsibilities:
 * - Initialize FFmpeg path
 * - Probe video metadata (duration, dimensions)
 * - Provide FFmpeg path to other services
 */

import { spawn } from 'child_process';

import * as mediaMetadataService from './media-metadata.service.js';

let ffmpegPath: string | null = null;
let initialized = false;

interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export type HardwareEncoder = 'h264_nvenc' | 'h264_amf' | 'h264_qsv' | 'libx264';

let availableEncoder: HardwareEncoder | null = null;

/**
 * Lazily initialize FFmpeg path
 */
export async function ensureInitialized(): Promise<void> {
  if (initialized) return;

  try {
    const ffmpegStatic = await import('ffmpeg-static');

    // @ts-expect-error - ffmpeg-static types are sometimes weird with default export
    let rawFfmpegPath = (ffmpegStatic.default as string) || null;

    // Fix paths for production (asar)
    if (rawFfmpegPath && rawFfmpegPath.includes('app.asar')) {
      rawFfmpegPath = rawFfmpegPath.replace('app.asar', 'app.asar.unpacked');
    }

    ffmpegPath = rawFfmpegPath;

    if (ffmpegPath) {
      console.log('[FFmpegService] FFmpeg initialized:', ffmpegPath);
    } else {
      console.error('[FFmpegService] FFmpeg path not found!');
    }

    initialized = true;
  } catch (err) {
    console.error('[FFmpegService] Failed to initialize ffmpeg-static:', err);
    throw err;
  }
}

/**
 * Get FFmpeg path
 */
export function getFfmpegPath(): string | null {
  return ffmpegPath;
}

/**
 * Probe video file for metadata
 */
export async function probeVideo(filePath: string): Promise<VideoMetadata> {
  return mediaMetadataService.probeVideoMetadata(filePath);
}

/**
 * Remux video to fix metadata (e.g. infinite duration)
 * Uses -c copy for instant processing
 */
export async function remuxVideo(inputPath: string, outputPath: string): Promise<void> {
  await ensureInitialized();

  if (!ffmpegPath) {
    throw new Error('FFmpeg not initialized');
  }

  return new Promise((resolve, reject) => {
    console.log('[FFmpegService] Remuxing video:', inputPath, '->', outputPath);

    const ffmpeg = spawn(ffmpegPath!, [
      '-i',
      inputPath,
      '-c',
      'copy',
      '-y', // Overwrite output if exists
      outputPath,
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log('[FFmpegService] Remux code 0 (success)');
        resolve();
      } else {
        console.error('[FFmpegService] Remux failed:', stderr);
        reject(new Error(`FFmpeg remux exited with code ${code}`));
      }
    });

    ffmpeg.on('error', (err) => {
      console.error('[FFmpegService] FFmpeg spawn error:', err);
      reject(err);
    });
  });
}

/**
 * Detect and cache the best available hardware encoder.
 * Priority: NVIDIA > AMD > Intel > CPU fallback
 */
async function detectHardwareEncoder(): Promise<HardwareEncoder> {
  if (!ffmpegPath) {
    throw new Error('FFmpeg not initialized');
  }

  return new Promise((resolve) => {
    const ffmpeg = spawn(ffmpegPath!, ['-encoders']);

    let output = '';
    ffmpeg.stdout.on('data', (data) => {
      output += data.toString();
    });

    ffmpeg.on('close', () => {
      // Check for hardware encoders in priority order
      if (output.includes('h264_nvenc')) {
        console.log('[FFmpegService] Hardware encoder detected: NVIDIA NVENC');
        resolve('h264_nvenc');
      } else if (output.includes('h264_amf')) {
        console.log('[FFmpegService] Hardware encoder detected: AMD AMF');
        resolve('h264_amf');
      } else if (output.includes('h264_qsv')) {
        console.log('[FFmpegService] Hardware encoder detected: Intel Quick Sync');
        resolve('h264_qsv');
      } else {
        console.log('[FFmpegService] No hardware encoder detected, using CPU: libx264');
        resolve('libx264');
      }
    });

    ffmpeg.on('error', () => {
      // Fallback to CPU on error
      console.warn('[FFmpegService] Encoder detection failed, falling back to libx264');
      resolve('libx264');
    });
  });
}

/**
 * Get the best available H.264 encoder.
 * Automatically detects and caches hardware encoder on first call.
 */
export async function getBestEncoder(): Promise<HardwareEncoder> {
  await ensureInitialized();

  if (availableEncoder) {
    return availableEncoder;
  }

  availableEncoder = await detectHardwareEncoder();
  return availableEncoder;
}
