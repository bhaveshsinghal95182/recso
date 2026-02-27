export const quality = [
  { value: 2500000, label: 'Low (2.5 Mbps)' },
  { value: 5000000, label: 'Standard (5 Mbps)' },
  { value: 15000000, label: 'High (15 Mbps)' },
  { value: 50000000, label: 'Ultra (50 Mbps)' },
];

export const formats = [
  { value: 'video/x-matroska;codecs=avc1', label: 'MKV (H.264)', extension: 'mkv' },
  { value: 'video/mp4;codecs=avc1', label: 'MP4 (H.264)', extension: 'mp4' },
  { value: 'video/webm;codecs=h264', label: 'WebM (H.264)', extension: 'webm' },
  { value: 'video/webm;codecs=vp9', label: 'WebM (VP9)', extension: 'webm' },
] as const;

export const GROUP_THRESHOLD_MS = 3000; // Max time between clicks to consider them part of the same action
export const ZOOM_DURATION_MS = 2000; // Duration to hold zoom after the last click in a group
export const PRE_CLICK_LEAD_MS = 500; // Start zooming slightly before the click
export const DEFAULT_ZOOM_LEVEL = 1.5; // Default zoom level
export const MIN_REGION_DURATION_MS = 200; // Minimum time a sub-region must last before we allow another split (ms)
export const VIEWPORT_PADDING = 0.05; // Padding inside viewport edge — pan triggers when mouse is within this fraction of the edge
