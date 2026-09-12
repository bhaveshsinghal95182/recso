import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '@/types';

import { defaultConfig } from '../functions';
import type { ExportPlan } from './plan';
import { runNativeExport } from './run-native-export';

const SCREEN_PATH = 'C:\\takes\\clip.mp4';
const MIC_PATH = 'C:\\takes\\clip_mic.mp4';

function project(): Project {
  return {
    id: 'project-1',
    name: 'Clip',
    recordingId: 'recording-1',
    projectFolderPath: 'C:\\takes\\clip',
    rawVideoPath: SCREEN_PATH,
    videoDimensions: { width: 1920, height: 1080 },
    timeline: { duration: 10_000, tracks: [] },
    cursorConfig: {
      size: 1,
      style: 'default',
      showClickAnimations: false,
      clickAnimationScale: 1.2,
      clickDisplayDuration: 500,
      showMotionBlur: false,
      motionBlurStrength: 0,
    },
    zoomConfig: { level: 1, focalX: 0.5, focalY: 0.5 },
    spritesheets: {},
    backgroundColor: '#000000',
    canvasBackgroundEnabled: false,
    cuts: [],
    zoomRegions: [],
    createdAt: 1,
    modifiedAt: 1,
  };
}

function plan(): ExportPlan {
  return {
    composition: {
      ...defaultConfig,
      background: { enabled: false, type: 'color', color: '#000000' },
      video: { ...defaultConfig.video, scale: 1 },
      layout: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
    },
    output: { width: 1920, height: 1080 },
    webcamSourcePath: undefined,
    sourceDurationMs: 10_000,
    compositionDurationMs: 10_000,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('runNativeExport', () => {
  it('uses the native probe to align a legacy audio sidecar before export', async () => {
    vi.useFakeTimers();

    const start = vi.fn().mockResolvedValue({ output: 'C:\\takes\\out.mp4' });
    const probeAudio = vi.fn().mockResolvedValue({
      hasAudio: true,
      sampleRate: 48_000,
      channels: 2,
      duration: 9_000,
    });

    vi.stubGlobal('window', {
      setInterval,
      clearInterval,
      electron: {
        exporter: {
          fileSize: vi.fn(async (path: string) => (path === MIC_PATH ? 1_000 : 0)),
        },
        engine: {
          probeAudio,
          export: {
            start,
            progress: vi.fn().mockResolvedValue({
              framesDone: 300,
              framesTotal: 300,
              finished: true,
              cancelled: false,
              fps: 30,
              steadyFps: 30,
              setupMs: 1,
              avgDecodeMs: 1,
              avgRenderMs: 1,
              avgEncodeMs: 1,
              elapsedMs: 10_000,
              output: 'C:\\takes\\out.mp4',
            }),
            cancel: vi.fn(),
          },
        },
      },
    });

    const running = runNativeExport({
      project: project(),
      config: {
        resolution: '1080p',
        format: 'mp4',
        quality: 'high',
        fps: 30,
        backgroundColor: '#000000',
      },
      plan: plan(),
      outputPath: 'C:\\takes\\out.mp4',
    });

    await vi.advanceTimersByTimeAsync(250);
    await expect(running).resolves.toMatchObject({
      outputPath: 'C:\\takes\\out.mp4',
      durationSeconds: 10,
    });

    expect(probeAudio).toHaveBeenCalledWith(MIC_PATH);
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0][1].audioSources).toEqual([{ path: MIC_PATH, offsetMs: 1_000 }]);
  });

  it('does not let a corrupt legacy audio sidecar block the video export', async () => {
    vi.useFakeTimers();

    const start = vi.fn().mockResolvedValue({ output: 'C:\\takes\\out.mp4' });
    vi.stubGlobal('window', {
      setInterval,
      clearInterval,
      electron: {
        exporter: {
          fileSize: vi.fn(async (path: string) => (path === MIC_PATH ? 1_000 : 0)),
        },
        engine: {
          probeAudio: vi.fn().mockRejectedValue(new Error('invalid AAC stream')),
          export: {
            start,
            progress: vi.fn().mockResolvedValue({
              framesDone: 300,
              framesTotal: 300,
              finished: true,
              cancelled: false,
              fps: 30,
              steadyFps: 30,
              setupMs: 1,
              avgDecodeMs: 1,
              avgRenderMs: 1,
              avgEncodeMs: 1,
              elapsedMs: 10_000,
              output: 'C:\\takes\\out.mp4',
            }),
            cancel: vi.fn(),
          },
        },
      },
    });

    const running = runNativeExport({
      project: project(),
      config: {
        resolution: '1080p',
        format: 'mp4',
        quality: 'high',
        fps: 30,
        backgroundColor: '#000000',
      },
      plan: plan(),
      outputPath: 'C:\\takes\\out.mp4',
    });

    await vi.advanceTimersByTimeAsync(250);
    await expect(running).resolves.toMatchObject({ outputPath: 'C:\\takes\\out.mp4' });
    expect(start.mock.calls[0][1].audioSources).toEqual([]);
  });
});
