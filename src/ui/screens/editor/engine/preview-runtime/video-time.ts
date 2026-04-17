export function getClampedVideoTime(video: HTMLVideoElement, targetSeconds: number): number {
  const safeTarget = Number.isFinite(targetSeconds) ? Math.max(0, targetSeconds) : 0;
  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    return safeTarget;
  }

  // Keep below exact duration to avoid triggering ended during seeks.
  return Math.min(safeTarget, Math.max(0, video.duration - 0.001));
}

export function syncVideoTime(
  video: HTMLVideoElement,
  targetMs: number,
  toleranceSeconds = 0.04,
): void {
  const nextSeconds = getClampedVideoTime(video, targetMs / 1000);
  if (Math.abs(video.currentTime - nextSeconds) > toleranceSeconds) {
    video.currentTime = nextSeconds;
  }
}
