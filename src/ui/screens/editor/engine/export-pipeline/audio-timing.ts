/**
 * Sidecar pipelines start after native screen capture but stop with it. Their
 * shorter duration therefore describes a start delay, within a conservative
 * range, rather than audio that should begin at composition time zero.
 */
const MAX_START_DELAY_COMPENSATION_SECONDS = 3;
const MIN_START_DELAY_COMPENSATION_SECONDS = 0.05;

export function resolveStartDelayCompensationSeconds(
  sourceDurationSeconds: number,
  sidecarDurationSeconds: number,
): number {
  if (!Number.isFinite(sourceDurationSeconds) || !Number.isFinite(sidecarDurationSeconds)) {
    return 0;
  }

  const delaySeconds = sourceDurationSeconds - sidecarDurationSeconds;
  if (
    delaySeconds < MIN_START_DELAY_COMPENSATION_SECONDS ||
    delaySeconds > MAX_START_DELAY_COMPENSATION_SECONDS
  ) {
    return 0;
  }

  return delaySeconds;
}
