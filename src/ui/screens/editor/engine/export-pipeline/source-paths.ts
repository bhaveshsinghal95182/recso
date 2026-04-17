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

function inferWebcamPathFromRawVideo(rawVideoPath: string | undefined): string | undefined {
  if (!rawVideoPath) {
    return undefined;
  }

  const lastDot = rawVideoPath.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === rawVideoPath.length - 1) {
    return undefined;
  }

  return `${rawVideoPath.slice(0, lastDot)}_camera${rawVideoPath.slice(lastDot)}`;
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
