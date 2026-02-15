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
import * as fs from 'fs';
import * as path from 'path';

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
import * as remotionRenderer from '../remotion-renderer.service.js';

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
      stage: 'composition',
      stagePercent: 0,
    },
    startedAt: Date.now(),
  };

  console.log('[ExporterService] Starting export:', currentJob.id);
  console.log('[ExporterService] Output path:', outputPath);

  try {
    // Use two-stage pipeline: Remotion (effects) → FFmpeg (cuts/upscaling)
    const result = await runTwoStagePipeline(project, config, outputPath);
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

  // Cancel Remotion rendering (Stage 1)
  remotionRenderer.cancelRender();

  // Cancel FFmpeg process (Stage 2)
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

  // Clean up temp directory
  const project = editorService.getActiveProject();
  if (project) {
    const tempDir = path.join(project.projectFolderPath, 'temp');
    if (fs.existsSync(tempDir)) {
      try {
        const files = fs.readdirSync(tempDir);
        for (const file of files) {
          const filePath = path.join(tempDir, file);
          if (fs.statSync(filePath).isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(filePath);
          }
          console.log('[ExporterService] Cleaned up temp:', file);
        }
      } catch (err) {
        console.warn('[ExporterService] Failed to cleanup temp dir:', err);
      }
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
 * Two-stage export pipeline.
 *
 * Modern pipeline architecture separating effects from post-processing:
 *
 * Stage 1: Remotion (0-60% progress)
 *   - Renders video with background, zoom, cursor effects
 *   - Uses React composition for smooth animations
 *   - Outputs intermediate MP4 file
 *
 * Stage 2: FFmpeg (60-100% progress)
 *   - Applies cuts to remove unwanted segments
 *   - Upscales video to target resolution
 *   - Applies audio processing
 *   - Outputs final MP4 file
 *
 * Why two stages?
 *   ✓ Remotion excels at visual effects and animations
 *   ✓ FFmpeg excels at cutting and codec optimization
 *   ✓ Each tool operates in its strength zone
 *   ✓ Easier to debug (can inspect intermediate file)
 *   ✓ Better quality than old FFmpeg-only approach
 *
 * @param project - Project to export
 * @param config - Export configuration
 * @param outputPath - Final output path
 * @returns Export result
 */
async function runTwoStagePipeline(
  project: Project,
  config: ExportConfig,
  outputPath: string,
): Promise<ExportResult> {
  console.log('[ExporterService] ====== Starting Two-Stage Pipeline ======');

  let remotionOutput: string | undefined;

  try {
    // ============================================================
    // STAGE 1: Remotion Rendering
    // ============================================================
    console.log('[ExporterService] STAGE 1: Remotion composition (0-60%)');
    console.log('[ExporterService] Rendering: background, video positioning, zoom, effects...');

    const remotionResult = await remotionRenderer.renderWithRemotion(
      project,
      config,
      (progress) => {
        if (!currentJob) return;

        // Map Remotion progress (0-100%) to total progress (0-60%)
        const stagePercent = progress.percent; // 0-100
        const totalPercent = Math.round(stagePercent * 0.6); // Maps to 0-60

        currentJob.progress = {
          percent: totalPercent,
          currentFrame: progress.renderedFrames,
          totalFrames: progress.totalFrames,
          fps: config.fps,
          eta: calculateETA(totalPercent, currentJob.startedAt),
          stage: 'composition',
          stagePercent: progress.percent,
        };

        // Emit to renderer process
        exporterEvents.emit('progress', currentJob.progress);
      },
    );

    // Check Remotion result
    if (!remotionResult.success || !remotionResult.outputPath) {
      throw new Error(remotionResult.error || 'Remotion render failed');
    }

    remotionOutput = remotionResult.outputPath;
    console.log('[ExporterService] ✓ STAGE 1 complete:', remotionOutput);

    const tempStats = fs.statSync(remotionOutput);
    console.log(
      '[ExporterService] Intermediate file size:',
      Math.round(tempStats.size / 1024 / 1024),
      'MB',
    );

    // ============================================================
    // STAGE 2: FFmpeg Post-Processing
    // ============================================================
    console.log('[ExporterService] STAGE 2: FFmpeg post-processing (60-100%)');
    console.log('[ExporterService] Applying: cuts, upscaling, audio...');

    const ffmpegResult = await runFFmpegPostProcessing(
      project,
      config,
      remotionOutput, // Input: Remotion's output
      outputPath, // Output: Final export path
      60, // Progress offset (start at 60%)
      remotionResult.sourceFps, // Source FPS for minterpolate conversion
    );

    console.log('[ExporterService] ✓ STAGE 2 complete');
    console.log('[ExporterService] ====== Pipeline Complete ======');

    // ============================================================
    // Cleanup Temp Files
    // ============================================================
    if (remotionOutput && fs.existsSync(remotionOutput)) {
      try {
        const tempDir = path.dirname(remotionOutput);
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log('[ExporterService] Cleaned up temp directory');
      } catch (cleanupError) {
        console.warn('[ExporterService] Failed to cleanup temp files:', cleanupError);
      }
    }

    return ffmpegResult;
  } catch (error) {
    console.error('[ExporterService] Pipeline failed:', error);

    // Clean up temp files on failure
    if (remotionOutput && fs.existsSync(remotionOutput)) {
      try {
        const tempDir = path.dirname(remotionOutput);
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log('[ExporterService] Cleaned up temp directory after error');
      } catch (cleanupError) {
        console.warn(
          '[ExporterService] Failed to cleanup temp directory after error:',
          cleanupError,
        );
      }
    }

    throw error;
  }
}

/**
 * FFmpeg post-processing stage.
 *
 * Takes Remotion's output and applies:
 *   - Cut filter: Remove unwanted segments
 *   - Scaling filter: Upscale to target resolution
 *
 * Why these filters only?
 *   - Background and zoom already applied by Remotion
 *   - Applying them again would double-process (wrong output)
 *   - Cuts must happen after effects (changes final duration)
 *   - Upscaling is FFmpeg's specialty (Lanczos algorithm)
 *
 * @param project - Project data (for cut regions)
 * @param config - Export config (for resolution)
 * @param inputPath - Remotion's output file
 * @param outputPath - Final output path
 * @param progressOffset - Starting progress percentage (typically 60)
 */
async function runFFmpegPostProcessing(
  project: Project,
  config: ExportConfig,
  inputPath: string,
  outputPath: string,
  progressOffset: number,
  sourceFps?: number,
): Promise<ExportResult> {
  const ffmpegPath = ffmpegService.getFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('FFmpeg not initialized');
  }

  // Probe the intermediate file from Remotion
  const metadata = await ffmpegService.probeVideo(inputPath);
  const videoDuration = metadata.duration;
  const totalFrames = Math.ceil(videoDuration * config.fps);

  console.log('[ExporterService] Post-processing:', totalFrames, 'frames');

  return new Promise((resolve, reject) => {
    // Create filter context for post-processing filters only
    const context = createFilterContext(project, config, videoDuration);

    // IMPORTANT: Only use cut and scaling filters
    // Background and zoom were already applied by Remotion
    // To not re-apply effects, we'd need to filter the filters, but for now
    // we rely on the fact that post-processing only needs cuts and scaling.
    const enabledFilters = getEnabledFilters(context);

    console.log(
      '[ExporterService] Post-process filters:',
      enabledFilters.map((f) => f.name),
    );

    // Collect video filters for post-processing
    const videoFilters: string[] = [];

    // FPS conversion via minterpolate removed due to extreme performance cost.
    // FFmpeg's default -r flag (added in getOutputSettingsArgs) handles frame duplication/dropping
    // which is standard behavior and much faster.
    if (sourceFps && sourceFps < config.fps) {
      console.log(
        `[ExporterService] FPS conversion: ${sourceFps} → ${config.fps} (standard duplication)`,
      );
    }

    for (const filter of enabledFilters) {
      const filters = filter.getVideoFilters(context);
      if (filters) {
        videoFilters.push(...filters);
      }
    }

    // Build FFmpeg arguments
    const args = [
      '-y', // Overwrite output
      '-i',
      inputPath,
    ];

    // Apply filters if any
    if (videoFilters.length > 0) {
      // Check if we have a complex filter (contains semicolons for multiple filter chains)
      const hasComplexFilter = videoFilters.some((f) => f.includes(';'));

      if (hasComplexFilter) {
        args.push('-filter_complex', videoFilters.join(','));
      } else {
        args.push('-vf', videoFilters.join(','));
      }
    }

    // Apply output settings
    const outputArgs = getOutputSettingsArgs(config);
    args.push(...outputArgs);

    // Output path
    args.push(outputPath);

    console.log('[ExporterService] FFmpeg post-process command:', ffmpegPath, args.join(' '));

    // Spawn FFmpeg
    const child = spawn(ffmpegPath, args);
    ffmpegProcess = child;

    let lastEmitTime = 0;
    const THROTTLE_MS = 200; // Emit progress max once per 200ms

    // Parse progress from stderr
    child.stderr.on('data', (data) => {
      const output = data.toString();

      const frameMatch = output.match(/frame=\s*(\d+)/);
      const fpsMatch = output.match(/fps=\s*(\d+(?:\.\d+)?)/);

      if (frameMatch && currentJob) {
        const currentFrame = parseInt(frameMatch[1], 10);
        const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 0;

        // Calculate progress within this stage (0-100%)
        const stagePercent = Math.min(100, (currentFrame / totalFrames) * 100);

        // Map to total progress (60-100%)
        const totalPercent = Math.round(progressOffset + stagePercent * 0.4);

        currentJob.progress = {
          percent: totalPercent,
          currentFrame,
          totalFrames,
          fps,
          eta: calculateETA(totalPercent, currentJob.startedAt),
          stage: 'export',
          stagePercent: stagePercent,
        };

        // Throttle updates to avoid overwhelming UI
        const now = Date.now();
        if (now - lastEmitTime >= THROTTLE_MS || totalPercent === 100) {
          exporterEvents.emit('progress', currentJob.progress);
          lastEmitTime = now;
        }
      }
    });

    // Handle completion
    child.on('close', (code) => {
      ffmpegProcess = null;

      if (code === 0) {
        // Success!
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
        // Failure
        if (currentJob?.state === 'cancelled') {
          reject(new Error('Export cancelled'));
        } else {
          reject(new Error(`FFmpeg exited with error code ${code}`));
        }
      }
    });

    // Handle spawn errors
    child.on('error', (err) => {
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
