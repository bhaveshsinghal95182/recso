import { CameraOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface CameraPreviewProps {
  deviceId: string | null;
  isActive: boolean;
  className?: string;
}

export function CameraPreview({ deviceId, isActive, className }: CameraPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
