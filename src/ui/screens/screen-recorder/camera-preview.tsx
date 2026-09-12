import { Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface CameraPreviewProps {
  deviceLabel: string | null;
  isActive: boolean;
  /** Where the picture comes from. A phone is a network source, not a local device. */
  source?: 'local' | 'phone';
  error?: string | null;
  className?: string;
}

/** Fast enough to frame a shot without moving full camera-rate data over IPC. */
const PREVIEW_POLL_MS = 80;

export function CameraPreview({
  deviceLabel,
  isActive,
  source = 'local',
  error,
  className,
}: CameraPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastNativeSequenceRef = useRef<number | null>(null);
  const [drawnSource, setDrawnSource] = useState<'local' | 'phone' | null>(null);
  const usingPhone = isActive && source === 'phone';
  const usingLocalCamera = isActive && source === 'local';
  const hasCurrentFrame = drawnSource === source;

  /**
   * Draw the newest frame from the owner that is already capturing it.
   *
   * Local frames are small JPEGs emitted by Velocity's native setup/recording
   * owner. Phone frames are the JPEGs already crossing the pairing server.
   * Neither path opens a second browser-side camera stream.
   */
  useEffect(() => {
    if (!usingPhone && !usingLocalCamera) {
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const drawLatest = () => {
      if (inFlight) {
        return;
      }
      inFlight = true;

      void (async () => {
        try {
          const nativeFrame = usingLocalCamera
            ? await window.electron.recorder.webcamPreviewFrame()
            : null;
          const jpeg = usingPhone ? await window.electron.phoneCamera.frame() : nativeFrame?.jpeg;

          if (
            cancelled ||
            !jpeg ||
            !canvasRef.current ||
            (nativeFrame && nativeFrame.sequence === lastNativeSequenceRef.current)
          ) {
            return;
          }

          const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
          if (cancelled) {
            bitmap.close();
            return;
          }

          const canvas = canvasRef.current;
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
          bitmap.close();
          if (nativeFrame) {
            lastNativeSequenceRef.current = nativeFrame.sequence;
          }
          setDrawnSource(source);
        } catch {
          // Retry a failed read/decode on the next tick. Startup failures are
          // reported by the camera owner and displayed below.
        } finally {
          inFlight = false;
        }
      })();
    };

    drawLatest();
    const timer = window.setInterval(drawLatest, PREVIEW_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [source, usingLocalCamera, usingPhone]);

  if (!isActive) return null;

  return (
    <Card
      className={cn(
        'block gap-0 p-0 overflow-hidden shadow-2xl border-2 border-brand/20 rounded-full aspect-square bg-black/90 relative group',
        className,
      )}
    >
      <canvas
        ref={canvasRef}
        className={cn(
          'block h-full w-full object-cover',
          // A local self-view is conventionally mirrored. The recorded file is
          // untouched; this transform is presentation-only.
          usingLocalCamera && '-scale-x-100',
        )}
      />
      {(!hasCurrentFrame || error) && (
        <div
          className="absolute inset-0 grid place-content-center justify-items-center gap-1.5 bg-neutral-900 px-3 text-center text-white/75"
          title={error ?? deviceLabel ?? 'Native webcam'}
        >
          <Video size={24} />
          <strong className="max-w-full truncate text-[10px] font-[650]">
            {deviceLabel ?? 'Native webcam'}
          </strong>
          <span className="line-clamp-2 text-[9px] text-white/45">
            {error ?? 'Starting native preview…'}
          </span>
        </div>
      )}
    </Card>
  );
}
