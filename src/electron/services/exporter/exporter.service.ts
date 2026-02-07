/**
 * Exporter Service
 *
 * Handles video export using FFmpeg with a modular filter pipeline.
 * Provides:
 * - Export job management (start, cancel, progress)
 * - FFmpeg pipeline construction with plugin filters
 * - Progress tracking and event emission
 */

import { type ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import { createFilterContext, getEnabledFilters } from './filters/index.js';
import type {
  ExportConfig,
  ExportJob,
  ExportProgress,
  ExportResult,
  ExportState,
} from '../../types/exporter.types.js';
import { QUALITY_CRF_MAP } from '../../types/exporter.types.js';
import type { Project } from '../../types/project.types.js';
import * as editorService from '../editor.service.js';
import * as ffmpegService from '../ffmpeg.service.js';

/**
 * Lazily initialize FFmpeg path
 */

/** Event emitter for progress updates */
export const exporterEvents = new EventEmitter();

/** Current export job (only one at a time) */
let currentJob: ExportJob | null = null;

/** Reference to FFmpeg process for cancellation */
let ffmpegProcess: ChildProcess | null = null;

/**
 * Start a new export job
 */
export async function startExport(config: ExportConfig): Promise<ExportResult> {
  // Initialize FFmpeg lazily on first export
  await ffmpegService.ensureInitialized();

  const project = editorService.getActiveProject();

  if (!project) {
    return { success: false, error: 'No active project' };
  }

  if (currentJob?.state === 'exporting') {
    return { success: false, error: 'Export already in progress' };
  }

  // Validate source file exists and is not empty
  if (!fs.existsSync(project.rawVideoPath)) {
    return { success: false, error: `Source video not found: ${project.rawVideoPath}` };
  }

  const stats = fs.statSync(project.rawVideoPath);
  if (stats.size === 0) {
    return { success: false, error: `Source video is empty (0 bytes): ${project.rawVideoPath}` };
  }

  // Create default exports folder in project directory
  const recordingDir = path.dirname(project.projectFolderPath);
  const defaultExportsDir = path.join(recordingDir, 'exports');
  if (!fs.existsSync(defaultExportsDir)) {
    fs.mkdirSync(defaultExportsDir, { recursive: true });
  }

  const exportsDir = config.outputFolder ? config.outputFolder : defaultExportsDir;
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }

  // Generate output filename with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ext = config.format === 'mp4' ? 'mp4' : 'webm';
  // Use custom filename if provided, else project name
  let baseNameRaw = config.outputFilename || project.name || 'export';
  // Remove existing extension if any
  baseNameRaw = baseNameRaw.replace(new RegExp(`\\.${ext}$`, 'i'), '');
  // Sanitize filename
  const sanitizedName = baseNameRaw.replace(/[^a-zA-Z0-9-_]/g, '_');

  const outputPath = path.join(exportsDir, `${sanitizedName}_${timestamp}.${ext}`);

  // Create job
  currentJob = {
    id: randomUUID(),
    projectId: project.id,
    state: 'exporting',
    config,
    outputPath,
    progress: {
      percent: 0,
      currentFrame: 0,
      totalFrames: 0,
      fps: 0,
      eta: 0,
    },
    startedAt: Date.now(),
  };

  console.log('[ExporterService] Starting export:', currentJob.id);
  console.log('[ExporterService] Output path:', outputPath);

  try {
    const result = await runFFmpegPipeline(project, config, outputPath);
    currentJob.state = 'completed';
    console.log('[ExporterService] Export completed successfully');
    return result;
  } catch (error) {
    currentJob.state = 'error';
    currentJob.error = error instanceof Error ? error.message : 'Unknown error';
    console.error('[ExporterService] Export failed:', currentJob.error);
    return { success: false, error: currentJob.error };
  }
}

/**
 * Cancel the current export
 */
export function cancelExport(): boolean {
  if (!currentJob || currentJob.state !== 'exporting') {
    return false;
  }

  console.log('[ExporterService] Cancelling export:', currentJob.id);

  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGKILL');
    ffmpegProcess = null;
  }

  currentJob.state = 'cancelled';

  // Clean up partial output file
  if (currentJob.outputPath && fs.existsSync(currentJob.outputPath)) {
    try {
      fs.unlinkSync(currentJob.outputPath);
      console.log('[ExporterService] Cleaned up partial file');
    } catch (err) {
      console.warn('[ExporterService] Failed to clean up partial file:', err);
    }
  }

  return true;
}

/**
 * Get current export progress
 */
export function getProgress(): ExportProgress | null {
  return currentJob?.progress || null;
}

/**
 * Get current export state
 */
export function getState(): ExportState {
  return currentJob?.state || 'idle';
}

/**
 * Get current job info
 */
export function getCurrentJob(): ExportJob | null {
  return currentJob;
}

/**
 * Get exports folder path for current project
 */
export function getExportsFolder(): string | null {
  const project = editorService.getActiveProject();
  if (!project) return null;
  const recordingDir = path.dirname(project.projectFolderPath);
  return path.join(recordingDir, 'exports');
}

/**
 * Build and run the FFmpeg pipeline with all enabled filters
 */
async function runFFmpegPipeline(
  project: Project,
  config: ExportConfig,
  outputPath: string,
): Promise<ExportResult> {
  const ffmpegPath = ffmpegService.getFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('FFmpeg not initialized');
  }

  // 1. Probe video duration
  const metadata = await ffmpegService.probeVideo(project.rawVideoPath);
  const videoDuration = metadata.duration;

  if (videoDuration === 0) {
    throw new Error('Source video duration is 0 seconds');
  }

  const totalFrames = Math.ceil(videoDuration * config.fps);
  console.log(
    '[ExporterService] Video duration:',
    videoDuration,
    's, estimated frames:',
    totalFrames,
  );

  return new Promise((resolve, reject) => {
    // Create filter context
    const context = createFilterContext(project, config, videoDuration);

    // Get enabled filters
    const enabledFilters = getEnabledFilters(context);
    console.log(
      '[ExporterService] Enabled filters:',
      enabledFilters.map((f) => f.name),
    );

    // Collect all video filters
    const videoFilters: string[] = [];
    for (const filter of enabledFilters) {
      const filters = filter.getVideoFilters(context);
      if (filters) {
        videoFilters.push(...filters);
      }
    }

    // Build arguments
    const args = [
      '-y', // Overwrite output
      '-i',
      project.rawVideoPath, // Input
    ];

    // Apply video filters
    if (videoFilters.length > 0) {
      // Check if we have a complex filter (contains semicolons for multiple filter chains)
      const hasComplexFilter = videoFilters.some((f) => f.includes(';'));

      if (hasComplexFilter) {
        // Use filter_complex for background images
        args.push('-filter_complex', videoFilters.join(','));
      } else {
        // Use simple vf for normal filters
        args.push('-vf', videoFilters.join(','));
      }
    }

    // Apply output settings
    const outputArgs = getOutputSettingsArgs(config);
    args.push(...outputArgs);

    // Output path
    args.push(outputPath);

    console.log('[ExporterService] FFmpeg command:', ffmpegPath, args.join(' '));

    // Spawn process
    const child = spawn(ffmpegPath, args);
    ffmpegProcess = child;

    // Handle progress
    child.stderr.on('data', (data) => {
      const output = data.toString();
      // Parse progress from stderr
      // Example: frame=  123 fps= 30 q=28.0 size=    123kB time=00:00:04.10 bitrate= 245.6kbits/s speed=1.02x
      const frameMatch = output.match(/frame=\s*(\d+)/);
      const fpsMatch = output.match(/fps=\s*(\d+(?:\.\d+)?)/);

      if (frameMatch && currentJob) {
        const currentFrame = parseInt(frameMatch[1], 10);
        const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 0;
        const percent = Math.min(100, Math.round((currentFrame / totalFrames) * 100));

        currentJob.progress = {
          percent,
          currentFrame,
          totalFrames,
          fps,
          eta: calculateETA(percent, currentJob.startedAt),
        };
        exporterEvents.emit('progress', currentJob.progress);
      }
    });

    child.on('close', (code) => {
      console.log('[ExporterService] FFmpeg process exited with code:', code);
      ffmpegProcess = null;

      if (code === 0) {
        // Success
        try {
          const stats = fs.statSync(outputPath);
          resolve({
            success: true,
            outputPath,
            duration: videoDuration,
            fileSize: stats.size,
          });
        } catch {
          resolve({
            success: true,
            outputPath,
            duration: videoDuration,
          });
        }
      } else {
        // Failure (if not explicitly cancelled, which matches 'process killed' usually but sometimes code is sigkill)
        // If we cancelled it in the code, currentJob.state should be 'cancelled'
        if (currentJob?.state === 'cancelled') {
          reject(new Error('Export cancelled'));
        } else {
          reject(new Error(`FFmpeg exited with error code ${code}`));
        }
      }
    });

    child.on('error', (err) => {
      console.error('[ExporterService] FFmpeg spawn error:', err);
      ffmpegProcess = null;
      reject(err);
    });
  });
}

function getOutputSettingsArgs(config: ExportConfig): string[] {
  const crf = QUALITY_CRF_MAP[config.quality];
  const args: string[] = [];

  // FPS
  args.push('-r', config.fps.toString());

  // Video codec and settings
  if (config.format === 'mp4') {
    // H.264 video
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      crf.toString(),
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
    );
    // AAC audio
    args.push('-c:a', 'aac', '-b:a', '128k');
  } else {
    // VP9 video
    args.push('-c:v', 'libvpx-vp9', '-crf', crf.toString(), '-b:v', '0', '-pix_fmt', 'yuv420p');
    // Opus audio
    args.push('-c:a', 'libopus', '-b:a', '128k');
  }

  return args;
}

/**
 * Calculate estimated time remaining
 */
function calculateETA(percent: number, startedAt: number): number {
  if (percent <= 0) return 0;

  const elapsed = (Date.now() - startedAt) / 1000; // seconds
  const totalEstimate = (elapsed / percent) * 100;
  return Math.max(0, Math.round(totalEstimate - elapsed));
}
