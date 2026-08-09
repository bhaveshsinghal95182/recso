/**
 * TimelineWaveform
 *
 * Renders a decoded audio waveform as a subtle texture behind a timeline lane.
 * Peaks are decoded once per media path and cached for the lifetime of the app.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const WAVEFORM_PEAK_COUNT = 2048;
const WAVEFORM_COLOR = 'rgba(255, 255, 255, 0.16)';
const waveformPeakCache = new Map<string, Promise<Float32Array>>();

function toFileUrl(path: string): string {
  if (path.startsWith('file:')) {
    return path;
  }

  const normalized = path.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }

  if (normalized.startsWith('/')) {
    return `file://${encodeURI(normalized)}`;
  }

  return normalized;
}

function extractWaveformPeaks(audioBuffer: AudioBuffer, targetCount: number): Float32Array {
  const channelData = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) =>
    audioBuffer.getChannelData(index),
  );
  const peakCount = Math.max(64, targetCount);
  const totalSamples = audioBuffer.length;
  const samplesPerPeak = Math.max(1, Math.floor(totalSamples / peakCount));
  const peaks = new Float32Array(peakCount);
  let maxPeak = 0;

  for (let peakIndex = 0; peakIndex < peakCount; peakIndex += 1) {
    const start = peakIndex * samplesPerPeak;
    const end =
      peakIndex === peakCount - 1 ? totalSamples : Math.min(totalSamples, start + samplesPerPeak);
    const span = Math.max(1, end - start);
    const stride = Math.max(1, Math.floor(span / 128));
    let localPeak = 0;

    for (const channel of channelData) {
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += stride) {
        const amplitude = Math.abs(channel[sampleIndex] ?? 0);
        if (amplitude > localPeak) {
          localPeak = amplitude;
        }
      }
    }

    peaks[peakIndex] = localPeak;
    if (localPeak > maxPeak) {
      maxPeak = localPeak;
    }
  }

  if (maxPeak > 0) {
    for (let index = 0; index < peaks.length; index += 1) {
      peaks[index] /= maxPeak;
    }
  }

  return peaks;
}

async function loadWaveformPeaks(videoPath: string): Promise<Float32Array> {
  const cached = waveformPeakCache.get(videoPath);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const sourceUrl = toFileUrl(videoPath);
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`Failed to read media for waveform (${response.status})`);
    }

    const bytes = await response.arrayBuffer();
    const audioContext = new AudioContext();
    try {
      const decoded = await audioContext.decodeAudioData(bytes.slice(0));
      return extractWaveformPeaks(decoded, WAVEFORM_PEAK_COUNT);
    } finally {
      await audioContext.close().catch(() => {
        // Best-effort cleanup.
      });
    }
  })();

  waveformPeakCache.set(videoPath, pending);

  try {
    return await pending;
  } catch (error) {
    waveformPeakCache.delete(videoPath);
    throw error;
  }
}

interface TimelineWaveformProps {
  videoPath: string | null;
}

export function TimelineWaveform({ videoPath }: TimelineWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);

  useEffect(() => {
    if (!videoPath) {
      setPeaks(null);
      return;
    }

    let cancelled = false;

    void loadWaveformPeaks(videoPath)
      .then((nextPeaks) => {
        if (!cancelled) {
          setPeaks(nextPeaks);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPeaks(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [videoPath]);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.floor(rect.width));
    const cssHeight = Math.max(1, Math.floor(rect.height));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const bufferWidth = Math.max(1, Math.floor(cssWidth * dpr));
    const bufferHeight = Math.max(1, Math.floor(cssHeight * dpr));

    if (canvas.width !== bufferWidth || canvas.height !== bufferHeight) {
      canvas.width = bufferWidth;
      canvas.height = bufferHeight;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (!peaks || peaks.length === 0) {
      return;
    }

    const centerY = cssHeight / 2;
    const barStepPx = 3;
    const barWidthPx = 1;

    ctx.fillStyle = WAVEFORM_COLOR;
    for (let x = 0; x < cssWidth; x += barStepPx) {
      const start = Math.floor((x / cssWidth) * peaks.length);
      const end = Math.min(peaks.length, Math.ceil(((x + barStepPx) / cssWidth) * peaks.length));

      let peak = 0;
      for (let index = start; index < end; index += 1) {
        const value = peaks[index] ?? 0;
        if (value > peak) {
          peak = value;
        }
      }

      const barHeight = Math.max(1, peak * cssHeight * 0.66);
      const y = centerY - barHeight / 2;
      ctx.fillRect(x, y, barWidthPx, barHeight);
    }
  }, [peaks]);

  useEffect(() => {
    drawWaveform();
  }, [drawWaveform]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const observer = new ResizeObserver(() => {
      drawWaveform();
    });
    observer.observe(canvas);

    return () => {
      observer.disconnect();
    };
  }, [drawWaveform]);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />;
}
