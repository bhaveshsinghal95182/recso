/**
 * Remotion Renderer Service
 *
 * Handles rendering video compositions using Remotion and Puppeteer.
 * Bridge between Electron backend and Remotion's rendering API.
 *
 * Overview:
 * 1. Bundles React composition (with caching)
 * 2. Calculates composition parameters from Project data
 * 3. Calls Remotion's renderMedia API
 * 4. Tracks progress and emits events
 * 5. Handles cancellation and cleanup
 */

import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ExportConfig } from '../types/exporter.types.js';
import { RESOLUTION_MAP } from '../types/exporter.types.js';
import type { Project } from '../types/project.types.js';
import type { RemotionRenderProgress, RemotionRenderResult } from '../types/remotion.types.js';
import { ensureChromeBrowser } from './chrome-resolver.service.js';
import * as compositorService from './compositor.service.js';
import * as ffmpegService from './ffmpeg.service.js';

/**
 * Cache for bundled composition.
 * Bundling is expensive (~5-10s), so cache persists across renders.
 */
let bundleCache: string | null = null;

/**
 * Cancellation flag for ongoing render.
 * Set to true to stop rendering; checked in onProgress callback.
 */
let isCancelled = false;

/**
 * Start a simple HTTP file server to serve the video file.
 * This is necessary because Chromium/Puppeteer blocks file:// URLs for security reasons.
 *
 * @param videoPath - Absolute path to video file
 * @returns Promise that resolves with { url, server } or rejects
 */
/**
 * Links or copies the video file to the bundle directory.
 * This allows using staticFile() efficiently without an HTTP server.
 *
 * Tries hard link first (instant), falls back to copy.
 */
function linkVideoToBundle(sourcePath: string, bundleDir: string, targetName: string): string {
  const targetPath = path.join(bundleDir, targetName);

  // Remove existing file if any (from previous failed runs)
  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
  }

  try {
    // Try hard link (fastest, same partition)
    fs.linkSync(sourcePath, targetPath);
    console.log('[RemotionRenderer] Linked video to bundle:', targetPath);
  } catch (err: any) {
    if (err.code === 'EXDEV') {
      // Cross-device link not allowed, fallback to copy
      console.log('[RemotionRenderer] Cross-device link failed, copying video to bundle...');
      fs.copyFileSync(sourcePath, targetPath);
    } else {
      throw err;
    }
  }

  return targetPath;
}

/**
 * Extract canvas dimensions from export configuration.
 * Resolves resolution preset or uses custom dimensions.
 *
 * @param config - Export configuration
 * @returns Canvas width and height
 */
function getCanvasDimensions(config: ExportConfig): { width: number; height: number } {
  if (config.resolution === 'custom') {
    const width = config.customWidth || 1920;
    const height = config.customHeight || 1080;
    return { width, height };
  }

  const resolution = RESOLUTION_MAP[config.resolution];
  return {
    width: resolution.width,
    height: resolution.height,
  };
}

/**
 * Render a video composition using Remotion.
 *
 * This function:
 * 1. Bundles the React composition (or uses cache)
 * 2. Calculates rendering parameters from Project data
 * 3. Calls Remotion's renderMedia API
 * 4. Tracks progress via onProgress callback
 * 5. Returns output file path on success
 *
 * @param project - Project data with video metadata
 * @param config - Export configuration (resolution, fps, codec)
 * @param onProgress - Callback for progress updates
 * @returns Result with success status and output path or error
 *
 * @example
 * const result = await renderWithRemotion(project, config, (progress) => {
 *   console.log(`Rendering: ${progress.percent}%`);
 * });
 *
 * if (result.success) {
 *   console.log('Output:', result.outputPath);
 * } else {
 *   console.error('Error:', result.error);
 * }
 */
export async function renderWithRemotion(
  project: Project,
  config: ExportConfig,
  onProgress: (progress: RemotionRenderProgress) => void,
): Promise<RemotionRenderResult> {
  isCancelled = false;
  const runId = randomUUID();

  // Create temporary directory for this render
  const tempDir = path.join(process.cwd(), 'temp', runId);
  fs.mkdirSync(tempDir, { recursive: true });

  const tempOutputPath = path.join(tempDir, 'output.mp4');
  let linkedVideoPath: string | null = null;

  try {
    console.log('[RemotionRenderer] ====== Starting Remotion Render ======');
    console.log('[RemotionRenderer] Run ID:', runId);
    console.log('[RemotionRenderer] Output:', tempOutputPath);

    // ========================================================
    // Step 1: Bundle the composition (or use cache)
    // ========================================================
    if (!bundleCache) {
      console.log('[RemotionRenderer] Bundling Remotion composition...');
      const startBundle = Date.now();

      // Resolve path to entry point
      const entryPoint = path.resolve(path.join(process.cwd(), 'src', 'remotion', 'index.tsx'));

      if (!fs.existsSync(entryPoint)) {
        throw new Error(`Remotion entry point not found: ${entryPoint}`);
      }

      console.log('[RemotionRenderer] Entry point:', entryPoint);

      // Bundle using Webpack
      const bundled = await bundle({
        entryPoint,
        webpackOverride: (config) => config,
      });

      bundleCache = bundled;

      const bundleTime = ((Date.now() - startBundle) / 1000).toFixed(2);
      console.log(`[RemotionRenderer] Bundle complete in ${bundleTime}s`);
      console.log('[RemotionRenderer] Bundle path:', bundleCache);
    } else {
      console.log('[RemotionRenderer] Using cached bundle');
      console.log('[RemotionRenderer] Bundle path:', bundleCache);
    }

    // ========================================================
    // Step 2: Ensure Chrome browser is available
    // ========================================================
    console.log('[RemotionRenderer] Ensuring Chrome browser is available...');
    const browserExecutable = await ensureChromeBrowser();
    console.log('[RemotionRenderer] Browser executable:', browserExecutable);

    // ========================================================
    // Step 3: Probe source video for duration
    // ========================================================
    console.log('[RemotionRenderer] Probing source video...');
    const metadata = await ffmpegService.probeVideo(project.rawVideoPath);
    const videoDuration = metadata.duration;

    if (videoDuration === 0) {
      throw new Error('Source video duration is 0 seconds');
    }

    console.log('[RemotionRenderer] Video duration:', videoDuration.toFixed(2), 's');

    // Use source video FPS for the intermediate render.
    // FFmpeg Stage 2 will handle FPS conversion (e.g. 30→60fps via minterpolate).
    // This halves the number of frames Remotion needs to render.
    const sourceFps = metadata.fps || 30;
    const renderFps = Math.min(sourceFps, config.fps); // Never render MORE frames than target
    const durationInFrames = Math.ceil(videoDuration * renderFps);
    console.log(
      '[RemotionRenderer] Render FPS:',
      renderFps,
      '(source:',
      sourceFps,
      ', target:',
      config.fps,
      ')',
    );
    console.log('[RemotionRenderer] Total frames:', durationInFrames);

    // ========================================================
    // Step 4: Get canvas dimensions from config
    // ========================================================
    const canvasDimensions = getCanvasDimensions(config);
    console.log('[RemotionRenderer] Canvas dimensions:', canvasDimensions);

    // ========================================================
    // Step 5: Calculate layout information
    // ========================================================
    // Reuses compositor service to ensure consistency with editor preview
    const layout = compositorService.calculateLayout(project.videoDimensions, canvasDimensions);

    console.log('[RemotionRenderer] Layout:', {
      canvasWidth: canvasDimensions.width,
      canvasHeight: canvasDimensions.height,
      videoPosition: { x: layout.x, y: layout.y },
      videoSize: { width: layout.width, height: layout.height },
      scale: layout.scale,
    });

    // ========================================================
    // Step 6: Link video file to bundle (for staticFile access)
    // ========================================================
    // Instead of an HTTP server, we link the file into the bundle directory
    // so it can be accessed via staticFile('video.mp4')
    const videoExt = path.extname(project.rawVideoPath);
    const videoFileName = `video-${runId}${videoExt}`;

    if (!bundleCache) {
      throw new Error('Bundle cache is null after bundling step');
    }

    // staticFile() resolves to /public/filename, so we must put the file in a 'public' subdir
    const bundlePublicDir = path.join(bundleCache, 'public');
    if (!fs.existsSync(bundlePublicDir)) {
      fs.mkdirSync(bundlePublicDir, { recursive: true });
    }

    console.log('[RemotionRenderer] Linking video to bundle public dir...');
    linkedVideoPath = linkVideoToBundle(project.rawVideoPath, bundlePublicDir, videoFileName);

    // ========================================================
    // Step 7: Prepare input props for composition
    // ========================================================
    // Transform zoom regions to composition format
    const zoomRegions = (project.zoomRegions || []).map((region: any) => ({
      id: region.id,
      startMs: region.startMs,
      endMs: region.endMs,
      zoomLevel: region.zoomLevel,
      focalX: region.focalX,
      focalY: region.focalY,
      easeDurationMs: region.easeDurationMs,
      focalKeyframes: region.focalKeyframes,
    }));

    const inputProps = {
      videoSrc: videoFileName, // Relative name for staticFile()
      backgroundColor: config.backgroundColor,
      backgroundPath: compositorService.getBackground(),
      layout,
      canvasWidth: canvasDimensions.width,
      canvasHeight: canvasDimensions.height,
      zoomRegions,
    };

    console.log('[RemotionRenderer] Input props prepared');
    console.log('[RemotionRenderer] Video source:', videoFileName);

    // ========================================================
    // Step 8: Select composition metadata
    // ========================================================
    console.log('[RemotionRenderer] Selecting composition...');
    const composition = await selectComposition({
      serveUrl: bundleCache,
      id: 'main',
      inputProps,
    });

    console.log('[RemotionRenderer] Composition selected:', composition.id);

    // ========================================================
    // Step 8: Render composition to video file
    // ========================================================
    console.log('[RemotionRenderer] Starting render...');
    const renderStart = Date.now();

    await renderMedia({
      composition: {
        ...composition,
        durationInFrames,
        fps: renderFps,
        width: canvasDimensions.width,
        height: canvasDimensions.height,
      },
      serveUrl: bundleCache,
      codec: 'h264',
      // === Performance: Fast intermediate encode ===
      // Since FFmpeg Stage 2 re-encodes at the user's target quality,
      // we use a fast, lower-quality encode here to avoid double-encoding.
      crf: 30, // Lower quality OK — FFmpeg re-encodes
      encodingMaxRate: '20M', // Bitrate cap for speed
      encodingBufferSize: '20M', // Required when maxRate is set
      imageFormat: 'jpeg', // Faster than PNG, no transparency needed
      jpegQuality: 80, // Good enough for intermediate
      concurrency: Math.max(1, Math.floor(os.cpus().length / 2)),
      outputLocation: tempOutputPath,
      inputProps,
      browserExecutable,
      // Configure Puppeteer to allow local file access
      // This is necessary for Chromium to load file:// URLs in the browser context
      puppeteerInstance: undefined,
      // Note: We use renderMedia's built-in Puppeteer which should handle file access
      onProgress: ({ renderedFrames, encodedFrames, encodedDoneIn }) => {
        // Check if render was cancelled
        if (isCancelled) {
          throw new Error('[RemotionRenderer] Render cancelled');
        }

        // Calculate progress percentage
        const percent = Math.round((renderedFrames / durationInFrames) * 100);

        // Emit progress to caller
        onProgress({
          renderedFrames,
          totalFrames: durationInFrames,
          percent,
          encodedFrames,
          encodedDoneIn,
        });

        // Log periodically (every 10%)
        if (percent % 10 === 0) {
          console.log(
            `[RemotionRenderer] Progress: ${renderedFrames}/${durationInFrames} (${percent}%)`,
          );
        }
      },
    });

    const renderTime = ((Date.now() - renderStart) / 1000).toFixed(2);
    console.log(`[RemotionRenderer] Render complete in ${renderTime}s`);

    // ========================================================
    // Step 9: Verify output file exists and is valid
    // ========================================================
    if (!fs.existsSync(tempOutputPath)) {
      throw new Error(`Output file not created: ${tempOutputPath}`);
    }

    const fileSize = fs.statSync(tempOutputPath).size;
    if (fileSize === 0) {
      throw new Error('Output file is empty (0 bytes)');
    }

    console.log('[RemotionRenderer] Output file size:', Math.round(fileSize / 1024 / 1024), 'MB');
    console.log('[RemotionRenderer] ====== Render Success ======');

    // Clean up file server
    console.log('[RemotionRenderer] ====== Render Success ======');

    // Clean up linked video file
    if (linkedVideoPath && fs.existsSync(linkedVideoPath)) {
      fs.unlinkSync(linkedVideoPath);
      console.log('[RemotionRenderer] Cleaned up linked video file');
    }

    return {
      success: true,
      outputPath: tempOutputPath,
      duration: videoDuration,
      sourceFps: renderFps,
    };
  } catch (error) {
    console.error('[RemotionRenderer] Render failed:', error);

    // Clean up linked video file on error
    if (linkedVideoPath && fs.existsSync(linkedVideoPath)) {
      try {
        fs.unlinkSync(linkedVideoPath);
        console.log('[RemotionRenderer] Cleaned up linked video file after error');
      } catch (cleanupError) {
        console.warn('[RemotionRenderer] Failed to cleanup linked video:', cleanupError);
      }
    }

    // Clean up temp directory on error
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log('[RemotionRenderer] Cleaned up temp directory');
      } catch (cleanupError) {
        console.warn('[RemotionRenderer] Failed to cleanup temp directory:', cleanupError);
      }
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during rendering',
    };
  }
}

/**
 * Cancel the ongoing Remotion render.
 *
 * Sets the cancellation flag, which causes the onProgress callback
 * to throw an error on the next invocation, stopping the render.
 *
 * The render will stop gracefully (no orphaned processes).
 *
 * @example
 * const renderPromise = renderWithRemotion(project, config, onProgress);
 * setTimeout(() => cancelRender(), 5000); // Cancel after 5 seconds
 */
export function cancelRender(): void {
  console.log('[RemotionRenderer] Cancellation requested');
  isCancelled = true;
}

/**
 * Clear the bundle cache.
 *
 * Forces rebundling on the next render.
 * Useful in development when composition code changes.
 *
 * In production, the bundle is typically generated once and reused.
 *
 * @example
 * // After updating effects in src/remotion/
 * clearCache();
 * // Next render will rebundle
 */
export function clearCache(): void {
  console.log('[RemotionRenderer] Clearing bundle cache');
  bundleCache = null;
}

/**
 * Get bundle cache status (for debugging).
 *
 * Useful for monitoring bundle caching behavior.
 *
 * @returns Object with cache status and path
 *
 * @example
 * const status = getBundleStatus();
 * console.log(status.cached ? `Cached: ${status.path}` : 'Not cached');
 */
export function getBundleStatus(): { cached: boolean; path: string | null } {
  return {
    cached: bundleCache !== null,
    path: bundleCache,
  };
}

/**
 * Get the current cancellation state.
 *
 * @returns true if a cancellation has been requested
 */
export function isCancelRequested(): boolean {
  return isCancelled;
}

/**
 * Reset the cancellation flag.
 *
 * Called automatically when starting a new render, but can be
 * reset manually if needed.
 *
 * @internal
 */
export function resetCancelFlag(): void {
  isCancelled = false;
}
