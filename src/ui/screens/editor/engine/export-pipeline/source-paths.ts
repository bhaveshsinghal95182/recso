import type { Project } from '@/types';

export function toFileUrl(rawPath: string | undefined): string {
  if (!rawPath) {
    return '';
  }

  if (rawPath.startsWith('file:')) {
    return rawPath;
  }

  const normalized = rawPath.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }

  if (normalized.startsWith('/')) {
    return `file://${encodeURI(normalized)}`;
  }

  return normalized;
}

function inferSidecarPathFromRawVideo(
  rawVideoPath: string | undefined,
  suffix: string,
): string | undefined {
  if (!rawVideoPath) {
    return undefined;
  }

  const lastDot = rawVideoPath.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === rawVideoPath.length - 1) {
    return undefined;
  }

  return `${rawVideoPath.slice(0, lastDot)}${suffix}${rawVideoPath.slice(lastDot)}`;
}

function inferWebcamPathFromRawVideo(rawVideoPath: string | undefined): string | undefined {
  return inferSidecarPathFromRawVideo(rawVideoPath, '_camera');
}

/**
 * Audio-only sidecars the recorder keeps next to the raw video whenever it could not embed those
 * streams into the recording itself. Missing files are handled by the caller.
 */
export function resolveProjectAudioSidecarPaths(
  project: Pick<Project, 'rawVideoPath'> | null | undefined,
): { desktopAudioPath?: string; micPath?: string } {
  return {
    desktopAudioPath: inferSidecarPathFromRawVideo(project?.rawVideoPath, '_desktop-audio'),
    micPath: inferSidecarPathFromRawVideo(project?.rawVideoPath, '_mic'),
  };
}

export function resolveProjectWebcamSourcePath(
  project: Pick<Project, 'rawVideoPath' | 'webcamOverlay'> | null | undefined,
): string | undefined {
  const explicitPath = project?.webcamOverlay?.sourcePath?.trim();
  if (explicitPath) {
    return explicitPath;
  }

  return inferWebcamPathFromRawVideo(project?.rawVideoPath);
}
