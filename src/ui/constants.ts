export const quality = [
  { value: 2500000, label: 'Low (2.5 Mbps)' },
  { value: 5000000, label: 'Standard (5 Mbps)' },
  { value: 15000000, label: 'High (15 Mbps)' },
  { value: 50000000, label: 'Ultra (50 Mbps)' },
];

export const formats = [
  { value: 'video/mp4;codecs=avc1', label: 'MP4 (H.264)', extension: 'mp4' },
  { value: 'video/webm;codecs=h264', label: 'WebM (H.264)', extension: 'webm' },
  { value: 'video/webm;codecs=vp9', label: 'WebM (VP9)', extension: 'webm' },
] as const;
