import { CameraOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface CameraPreviewProps {
  deviceId: string | null;
  isActive: boolean;
  /** Where the picture comes from. A phone is not a `getUserMedia` device. */
  source?: 'local' | 'phone';
  className?: string;
}

/** How often to pull a frame from the phone. Fast enough to frame a shot by. */
const PHONE_PREVIEW_MS = 80;

export function CameraPreview({
  deviceId,
  isActive,
  source = 'local',
  className,
}: CameraPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const usingPhone = isActive && source === 'phone';

  /**
   * The phone's picture, pulled from the pairing server rather than opened.
   *
   * `getUserMedia` can only reach cameras attached to this machine, so a paired
   * phone would otherwise show the laptop's own webcam here -- the wrong face,
   * with nothing on screen suggesting anything was wrong. The frames are
   * already passing through the main process on their way to the recorder; this
   * draws the newest one.
   */
  useEffect(() => {
    if (!usingPhone) {
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const timer = window.setInterval(() => {
      if (inFlight) {
        return;
      }
      inFlight = true;

      void (async () => {
        try {
          const bytes = await window.electron.phoneCamera.frame();
          if (cancelled || !bytes || !canvasRef.current) {
            return;
          }

          const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
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
          setError(null);
        } catch {
          // A frame that will not decode is not worth a visible error: the next
          // one is eighty milliseconds away, and the pairing panel is where a
          // real connection problem gets reported.
        } finally {
          inFlight = false;
        }
      })();
    }, PHONE_PREVIEW_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [usingPhone]);

  useEffect(() => {
    // The phone has no local device to open, and asking for one would light up
    // the laptop's camera for a preview nobody is looking at.
    if (usingPhone) {
      return;
    }

    let currentStream: MediaStream | null = null;

    const startPreview = async () => {
      if (!isActive) {
        if (stream) {
          stream.getTracks().forEach((track) => track.stop());
          setStream(null);
        }
        return;
      }

      try {
        setError(null);
        currentStream = await navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId: { exact: deviceId } } : true,
        });

        if (videoRef.current) {
          videoRef.current.srcObject = currentStream;
        }
        setStream(currentStream);
      } catch (err) {
        console.error('[CameraPreview] Failed to start preview:', err);
        setError('Failed to load preview');
      }
    };

    startPreview();

    return () => {
      if (currentStream) {
        currentStream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [deviceId, isActive]);

  if (!isActive) return null;

  return (
    <Card
      className={cn(
        'overflow-hidden shadow-2xl border-2 border-brand/20 rounded-full aspect-square bg-black/90 relative group',
        className,
      )}
    >
      {error ? (
        <div className="flex items-center justify-center w-full h-full text-muted-foreground bg-neutral-900">
          <CameraOff size={24} />
        </div>
      ) : usingPhone ? (
        // Not mirrored: the phone is pointing at the room, not back at you, so
        // flipping it would be showing something that is not there.
        <canvas ref={canvasRef} className="w-full h-full object-cover" />
      ) : (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover mirror"
          style={{ transform: 'scaleX(-1)' }}
        />
      )}
    </Card>
  );
}
