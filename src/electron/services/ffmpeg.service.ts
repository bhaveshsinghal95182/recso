/**
 * FFmpeg Service
 *
 * Centralized service for FFmpeg operations.
 * Responsibilities:
 * - Initialize FFmpeg and FFprobe paths
 * - Probe video metadata (duration, dimensions)
 * - Provide FFmpeg/FFprobe paths to other services
 */

import { spawn } from 'child_process';

let ffmpegPath: string | null = null;
let ffprobePath: string | null = null;
let initialized = false;

interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
}

/**
 * Lazily initialize FFmpeg/FFprobe paths
 */
export async function ensureInitialized(): Promise<void> {
  if (initialized) return;

  try {
    const ffmpegStatic = await import('ffmpeg-static');
    const ffprobeStatic = await import('ffprobe-static');

    // @ts-expect-error - ffmpeg-static types are sometimes weird with default export
    let rawFfmpegPath = (ffmpegStatic.default as string) || null;
    let rawFfprobePath = ffprobeStatic.default?.path || null;

    // Fix paths for production (asar)
    if (rawFfmpegPath && rawFfmpegPath.includes('app.asar')) {
      rawFfmpegPath = rawFfmpegPath.replace('app.asar', 'app.asar.unpacked');
    }
    if (rawFfprobePath && rawFfprobePath.includes('app.asar')) {
      rawFfprobePath = rawFfprobePath.replace('app.asar', 'app.asar.unpacked');
    }

    ffmpegPath = rawFfmpegPath;
    ffprobePath = rawFfprobePath;

    if (ffmpegPath) {
      console.log('[FFmpegService] FFmpeg initialized:', ffmpegPath);
    } else {
      console.error('[FFmpegService] FFmpeg path not found!');
    }

    if (ffprobePath) {
      console.log('[FFmpegService] FFprobe initialized:', ffprobePath);
    } else {
      console.error('[FFmpegService] FFprobe path not found!');
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
 * Get FFprobe path
 */
export function getFfprobePath(): string | null {
  return ffprobePath;
}

/**
 * Probe video file for metadata
 */
export async function probeVideo(filePath: string): Promise<VideoMetadata> {
  await ensureInitialized();

  if (!ffprobePath) {
    throw new Error('FFprobe not initialized');
  }

  return new Promise((resolve, reject) => {
    const ffprobe = spawn(ffprobePath!, [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=width,height',
      '-of',
      'json',
      filePath,
    ]);

    let output = '';
    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code === 0) {
        try {
          const data = JSON.parse(output);
          const duration = parseFloat(data.format?.duration || '0');
          const videoStream = data.streams?.find((s: any) => s.width && s.height);
          const width = Number(videoStream?.width) || 1920;
          const height = Number(videoStream?.height) || 1080;

          resolve({
            duration: isNaN(duration) ? 0 : duration,
            width,
            height,
          });
        } catch (err) {
          reject(new Error('Failed to parse ffprobe output'));
        }
      } else {
        reject(new Error(`FFprobe exited with code ${code}`));
      }
    });

    ffprobe.on('error', (err) => {
      reject(err);
    });
  });
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
