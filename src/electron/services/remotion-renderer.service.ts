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

import { app } from 'electron';

import { bundle } from '@remotion/bundler';
import { renderMedia } from '@remotion/renderer';
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
 * Calculate intermediate encoding quality settings based on export quality preset.
 * Intermediate renders need high quality to avoid generation loss, but we can
 * still scale appropriately while balancing encoding speed.
 *
 * @param exportQuality - Quality preset from export config
 * @returns Object with CRF and JPEG quality values
 */
function getIntermediateQuality(exportQuality: string): {
  crf: number;
  jpegQuality: number;
  preset: string;
  tune: string;
  keyframeInterval: number;
  bFrames: number;
  x264Params: string;
} {
  // Base x264 params shared across all quality levels.
  // These are tuned for screen-recording content (flat areas, sharp text edges).
  //
  // ref        – reference frames for motion compensation (higher = better quality, slower)
  // me         – motion estimation algorithm (hex = good speed/quality tradeoff)
  // subme      – sub-pixel motion estimation quality (higher = better, slower)
  // trellis    – trellis quantization (1 = final MB only, good quality boost)
  const BASE_X264 = 'me=hex:trellis=1';

  switch (exportQuality) {
    case 'low':
      // Low: Prioritize encoding speed, but maintain good intermediate quality
      return {
        crf: 16, // Was 20 - lowered to preserve quality for Stage 2
        jpegQuality: 92, // Was 90 - increased to reduce JPEG artifacts
        preset: 'fast',
        tune: 'animation', // Good for screen content (flat areas, sharp edges)
        keyframeInterval: 60,
        bFrames: 2,
        x264Params: `ref=2:subme=4:${BASE_X264}`,
      };
    case 'medium':
      // Medium: Balanced quality and encoding speed, high intermediate quality
      return {
        crf: 14, // Was 18 - lowered to minimize generation loss
        jpegQuality: 95, // Was 93 - increased for better frame quality
        preset: 'medium',
        tune: 'animation',
        keyframeInterval: 48,
        bFrames: 2,
        x264Params: `ref=3:subme=6:${BASE_X264}`,
      };
    case 'high':
      // High: Very high quality intermediate, minimal generation loss
      return {
        crf: 10, // Was 15 - lowered significantly for near-lossless intermediate
        jpegQuality: 98, // Was 96 - increased to maximum practical quality
        preset: 'slow', // Was 'medium' - slower but better quality
        tune: 'film', // Film for maximum fidelity at high quality
        keyframeInterval: 30,
        bFrames: 3,
        x264Params: `ref=5:subme=8:${BASE_X264}:me=umh`, // Added umh for better motion estimation
      };
    case 'lossless':
      // Lossless: Visually lossless (CRF 10 for H264 compatibility)
      return {
        crf: 10, // Visually lossless, avoids H264 CRF=0 platform issues
        jpegQuality: 100, // Maximum quality
        preset: 'slow', // Slower but highest quality
        tune: 'film',
        keyframeInterval: 15,
        bFrames: 3,
        x264Params: `ref=5:subme=10:trellis=2:me=umh`, // Maximum quality parameters
      };
    default:
      // Fallback to medium
      return {
        crf: 14,
        jpegQuality: 95,
        preset: 'medium',
        tune: 'animation',
        keyframeInterval: 48,
        bFrames: 2,
        x264Params: `ref=3:subme=6:${BASE_X264}`,
      };
  }
}

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
    // Try hard link (fastest, same partition, instant)
    fs.linkSync(sourcePath, targetPath);
    console.log('[RemotionRenderer] Hard-linked video to bundle:', targetPath);
  } catch (err: any) {
    if (err.code === 'EXDEV') {
      // Cross-device: hard link not possible, try symlink (instant, works cross-device)
      try {
        fs.symlinkSync(sourcePath, targetPath);
        console.log('[RemotionRenderer] Symlinked video to bundle (cross-device):', targetPath);
      } catch {
        // Symlink may fail on Windows without admin/developer mode
        // Last resort: full file copy (slow for large videos)
        console.log(
          '[RemotionRenderer] Symlink failed, falling back to copy (this may be slow for large files)...',
        );
        fs.copyFileSync(sourcePath, targetPath);
        console.log('[RemotionRenderer] Copied video to bundle:', targetPath);
      }
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
 * Calculate optimal intermediate render resolution.
 *
 * Strategy:
 * - 720p: Render at 720p (no change)
 * - 1080p: Render at 1080p (no change)
 * - 4K: Render at 1080p, upscale in FFmpeg (saves ~75% render time)
 * - Custom: Smart scaling based on size
 *
 * This optimization dramatically improves 4K render performance while maintaining
 * output quality since FFmpeg uses high-quality Lanczos upscaling.
 *
 * @param config - Export configuration
 * @returns Intermediate render dimensions and final target dimensions
 */
function getIntermediateRenderDimensions(config: ExportConfig): {
  intermediate: { width: number; height: number };
  final: { width: number; height: number };
} {
  const finalDimensions = getCanvasDimensions(config);

  // For 4K exports, render at 1080p intermediate
  if (config.resolution === '4k') {
    return {
      intermediate: { width: 1920, height: 1080 },
      final: finalDimensions,
    };
  }

  // For custom resolutions larger than 1080p, cap intermediate at 1080p
  if (config.resolution === 'custom') {
    const maxDimension = Math.max(finalDimensions.width, finalDimensions.height);
    if (maxDimension > 1920) {
      // Scale down to 1080p while maintaining aspect ratio
      const scale = 1920 / maxDimension;
      return {
        intermediate: {
          width: Math.round(finalDimensions.width * scale),
          height: Math.round(finalDimensions.height * scale),
        },
        final: finalDimensions,
      };
    }
  }

  // For 720p and 1080p, render at native resolution
  return {
    intermediate: finalDimensions,
    final: finalDimensions,
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
  // Create temporary directory for this render
  // Use app.getPath('temp') to avoid issues with process.cwd() in production (e.g. System32)
  const tempDir = path.join(app.getPath('temp'), 'recso-render', runId);
  fs.mkdirSync(tempDir, { recursive: true });

  const tempOutputPath = path.join(tempDir, 'output.mp4');
  let linkedVideoPath: string | null = null;
  let binariesDirectory: string | null = null;

  try {
    console.log('[RemotionRenderer] ====== Starting Remotion Render ======');
    console.log('[RemotionRenderer] Run ID:', runId);
    console.log('[RemotionRenderer] Output:', tempOutputPath);

    // ========================================================
    // Step 1: Bundle the composition (or use cache)
    // ========================================================

    // Check if we are running in production (packaged)
    const isProduction = app.isPackaged;

    if (isProduction) {
      console.log('[RemotionRenderer] Running in PRODUCTION mode');
      // In production, use the pre-bundled assets in resources/dist-remotion
      // Electron unpacks extraResources to resources/ directory next to the executable
      const resourcesPath = process.resourcesPath;
      const preBundledPath = path.join(resourcesPath, 'dist-remotion');

      console.log('[RemotionRenderer] Checking for pre-bundled assets at:', preBundledPath);

      if (fs.existsSync(preBundledPath)) {
        // In APPX/MSIX, the resources folder is strictly read-only.
        // We need to link/copy the user's video into the bundle's 'public' folder,
        // so we need a WRITABLE copy of the bundle.
        //
        // Performance optimization: Copy once to a persistent location in userData
        // and reuse it across renders (bundleCache persists across renders).
        if (!bundleCache) {
          const writableBundlePath = path.join(app.getPath('userData'), '.remotion-bundle');

          // Only copy if the writable bundle doesn't exist yet
          if (!fs.existsSync(writableBundlePath)) {
            console.log('[RemotionRenderer] First render: copying bundle to writable location...');
            fs.cpSync(preBundledPath, writableBundlePath, { recursive: true });
            console.log('[RemotionRenderer] Bundle copied to:', writableBundlePath);
          } else {
            console.log(
              '[RemotionRenderer] Using existing writable bundle at:',
              writableBundlePath,
            );
          }

          bundleCache = writableBundlePath;
        } else {
          console.log('[RemotionRenderer] Using cached writable bundle');
        }

        // Configure Remotion to use unpacked binaries from app.asar.unpacked
        // The path structure is: resources-path/app.asar.unpacked/node_modules/@remotion/compositor-win32-x64-msvc
        const unpackedBinariesDir = path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          '@remotion',
          'compositor-win32-x64-msvc',
        );

        console.log('[RemotionRenderer] Setting binaries directory to:', unpackedBinariesDir);
        binariesDirectory = unpackedBinariesDir;
      } else {
        console.error('[RemotionRenderer] pre-bundled assets NOT FOUND at:', preBundledPath);
        throw new Error(`Remotion bundle not found in resources: ${preBundledPath}`);
      }
    } else {
      // Development mode: Runtime bundling
      if (!bundleCache) {
        console.log(
          '[RemotionRenderer] Running in DEVELOPMENT mode - Bundling Remotion composition...',
        );
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
    }

    // ========================================================
    // Step 2 + 3: Resolve Chrome & probe video IN PARALLEL
    // ========================================================
    // These are independent async operations that each take 200ms+.
    // Running them concurrently saves ~0.5-1s on every export.
    console.log('[RemotionRenderer] Resolving Chrome browser + probing video (parallel)...');
    const [browserExecutable, metadata] = await Promise.all([
      ensureChromeBrowser(),
      ffmpegService.probeVideo(project.rawVideoPath),
    ]);
    console.log('[RemotionRenderer] Browser executable:', browserExecutable);

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

    // Calculate total cut duration and subtract from video duration
    // so Remotion only renders uncut frames (frame-skipping optimization)
    const cuts = project.cuts || [];
    const totalCutDurationSec = cuts.reduce(
      (sum, cut) => sum + (cut.endMs - cut.startMs) / 1000,
      0,
    );
    const effectiveDuration = videoDuration - totalCutDurationSec;
    const durationInFrames = Math.ceil(effectiveDuration * renderFps);

    console.log(
      '[RemotionRenderer] Render FPS:',
      renderFps,
      '(source:',
      sourceFps,
      ', target:',
      config.fps,
      ')',
    );
    if (cuts.length > 0) {
      console.log(
        `[RemotionRenderer] Cuts: ${cuts.length} regions, ${totalCutDurationSec.toFixed(2)}s removed`,
      );
      console.log(
        `[RemotionRenderer] Effective duration: ${effectiveDuration.toFixed(2)}s (was ${videoDuration.toFixed(2)}s)`,
      );
    }
    console.log('[RemotionRenderer] Total frames:', durationInFrames);

    // ========================================================
    // Step 4: Calculate intermediate and final dimensions
    // ========================================================
    const dimensions = getIntermediateRenderDimensions(config);
    const canvasDimensions = dimensions.intermediate;

    console.log('[RemotionRenderer] Target resolution:', config.resolution);
    console.log('[RemotionRenderer] Final dimensions:', dimensions.final);
    console.log('[RemotionRenderer] Intermediate render dimensions:', canvasDimensions);

    if (
      canvasDimensions.width !== dimensions.final.width ||
      canvasDimensions.height !== dimensions.final.height
    ) {
      const pixelReduction = (
        (1 -
          (canvasDimensions.width * canvasDimensions.height) /
            (dimensions.final.width * dimensions.final.height)) *
        100
      ).toFixed(1);
      console.log(
        `[RemotionRenderer] Performance optimization: Rendering at lower resolution, ` +
          `will upscale in FFmpeg stage (${pixelReduction}% fewer pixels to render)`,
      );
    }

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
    // Link the video into the bundle's public dir so Remotion's compositor
    // can access it via the built-in HTTP server (http://localhost:PORT/public/...).
    // The compositor only supports http/https URLs — file:// is rejected.
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

    // Transform cuts for composition (simple passthrough)
    const compositionCuts = cuts.map((cut) => ({
      id: cut.id,
      startMs: cut.startMs,
      endMs: cut.endMs,
    }));

    const sourceDurationMs = videoDuration * 1000;

    const inputProps = {
      videoSrc: videoFileName, // Relative name for staticFile()
      backgroundColor: config.backgroundColor,
      backgroundPath: compositorService.getBackground(),
      backgroundPattern: project.backgroundPattern,
      sourceWidth: project.videoDimensions.width,
      sourceHeight: project.videoDimensions.height,
      layout,
      canvasWidth: canvasDimensions.width,
      canvasHeight: canvasDimensions.height,
      zoomRegions,
      cuts: compositionCuts,
      sourceDurationMs,
    };

    console.log('[RemotionRenderer] Input props prepared');
    console.log('[RemotionRenderer] Video source:', videoFileName);
    console.log('[RemotionRenderer] Background color:', config.backgroundColor);
    console.log('[RemotionRenderer] Background path:', compositorService.getBackground());
    console.log('[RemotionRenderer] Background pattern:', project.backgroundPattern?.id || 'none');

    // ========================================================
    // Step 8: Build composition metadata directly (skip selectComposition)
    // ========================================================
    // OPTIMIZATION: selectComposition() launches a full Puppeteer browser instance,
    // loads the bundle, and evaluates React just to read composition metadata.
    // This adds 2-5 seconds of cold-start delay on EVERY export.
    //
    // Since we already know all the metadata (dimensions, fps, duration are all
    // calculated above, and composition id is always 'main'), we construct the
    // composition object directly — bypassing the browser round-trip entirely.
    const composition = {
      id: 'main' as const,
      durationInFrames,
      fps: renderFps,
      width: canvasDimensions.width,
      height: canvasDimensions.height,
      defaultProps: inputProps as Record<string, unknown>,
      props: inputProps as Record<string, unknown>,
      defaultCodec: 'h264' as const,
      defaultOutName: null,
      defaultVideoImageFormat: null,
      defaultPixelFormat: null,
      defaultProResProfile: null,
    };

    console.log('[RemotionRenderer] Composition built directly (skipped selectComposition)');

    // ========================================================
    // Step 9: Render composition to video file
    // ========================================================
    console.log('[RemotionRenderer] Starting render...');
    const glRendererLabel = config.glRenderer || 'null';
    console.log(
      '[RemotionRenderer] GL Renderer:',
      glRendererLabel,
      glRendererLabel === 'angle'
        ? '(GPU-accelerated)'
        : glRendererLabel === 'null'
          ? '(Chrome auto-select)'
          : '',
    );

    // Calculate intermediate quality based on export quality preset
    const intermediateQuality = getIntermediateQuality(config.quality);
    console.log(
      '[RemotionRenderer] Intermediate quality:',
      config.quality,
      `(CRF: ${intermediateQuality.crf}, JPEG: ${intermediateQuality.jpegQuality}, ` +
        `preset: ${intermediateQuality.preset}, tune: ${intermediateQuality.tune})`,
    );
    console.log(
      '[RemotionRenderer] x264 params:',
      intermediateQuality.x264Params,
      `(g=${intermediateQuality.keyframeInterval}, bf=${intermediateQuality.bFrames})`,
    );

    const renderStart = Date.now();

    // Calculate thread count for x264 encoding (match concurrency)
    const cpuThreads = Math.max(1, os.cpus().length - 1);

    // Cap browser concurrency to prevent overwhelming Chrome's network stack.
    // Too many parallel tabs hitting the local proxy (/proxy?src=...) simultaneously
    // causes net::ERR_NETWORK_CHANGED on large videos (especially .mkv).
    // 4 concurrent pages is a safe sweet-spot for stability vs speed.
    const renderConcurrency = Math.min(cpuThreads, 4);

    await renderMedia({
      composition,
      serveUrl: bundleCache,
      codec: 'h264',
      // === Performance: Adaptive intermediate encode quality ===
      // Quality scales with export preset to balance speed and avoid generation loss
      crf: intermediateQuality.crf,
      imageFormat: 'jpeg', // Faster than PNG, no transparency needed
      jpegQuality: intermediateQuality.jpegQuality,
      // Cap concurrency to prevent network exhaustion on large video files
      concurrency: renderConcurrency,
      outputLocation: tempOutputPath,
      inputProps,
      browserExecutable,
      // Configure Puppeteer to allow local file access
      // This is necessary for Chromium to load file:// URLs in the browser context
      puppeteerInstance: undefined,
      binariesDirectory,
      // Better logging for monitoring render progress and debugging issues
      logLevel: 'info',
      // Safety timeout: 30 minutes for long videos, prevents infinite hangs
      timeoutInMilliseconds: 1_800_000,
      // === x264 encoding optimization via FFmpeg flags ===
      // Provides fine-grained control over the intermediate encode:
      //   -preset   : Speed/quality tradeoff (adaptive per quality level)
      //   -tune     : Content type hint (animation for screen recordings, film for high quality)
      //   -g        : Keyframe interval (shorter = better seeking, slightly larger file)
      //   -bf       : B-frames for better compression efficiency
      //   -threads  : Match encoding threads to available CPU cores
      //   -x264-params : Advanced x264 settings (ref frames, motion estimation, trellis)
      ffmpegOverride: ({ args }) => {
        return [
          ...args,
          '-preset',
          intermediateQuality.preset,
          '-tune',
          intermediateQuality.tune,
          '-threads',
          String(cpuThreads),
          '-x264-params',
          intermediateQuality.x264Params,
          '-g',
          String(intermediateQuality.keyframeInterval),
          '-bf',
          String(intermediateQuality.bFrames),
        ];
      },
      // Configure GL renderer backend for GPU usage
      chromiumOptions: {
        gl: config.glRenderer ?? null, // Use configured GL renderer or default (null)
      },
      onProgress: ({ renderedFrames, encodedFrames, encodedDoneIn }) => {
        // Check if render was cancelled
        if (isCancelled) {
          throw new Error('Export cancelled');
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

/**
 * Pre-warm expensive resources at app startup.
 *
 * Call this early (e.g. during app.on('ready')) so that the Chrome binary
 * path is resolved and cached before the user ever clicks Export.
 * In dev mode this may trigger a one-time Chrome download (~200 MB);
 * in production it simply resolves the bundled path (<5 ms).
 *
 * This is fire-and-forget — errors are logged but never thrown so
 * they don't block app startup.
 *
 * @example
 * // In main.ts, after app is ready
 * import { preWarm } from './services/remotion-renderer.service.js';
 * preWarm();
 */
export function preWarm(): void {
  console.log('[RemotionRenderer] Pre-warming: resolving Chrome browser path...');
  ensureChromeBrowser()
    .then((browserPath) => {
      console.log('[RemotionRenderer] Pre-warm complete. Chrome ready at:', browserPath);
    })
    .catch((err) => {
      console.warn('[RemotionRenderer] Pre-warm failed (will retry at export time):', err);
    });
}
