import { AppWindow, Monitor, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DesktopSource } from '@/types';

import { CameraPreview } from './camera-preview';

interface CapturePreviewStageProps {
  selectedSource: DesktopSource | undefined;
  isLoading: boolean;
  isRecording: boolean;
  isPaused: boolean;
  isStopping: boolean;
  recordCamera: boolean;
  cameraDeviceId: string | null;
  onRefresh: () => void;
}

export function CapturePreviewStage({
  selectedSource,
  isLoading,
  isRecording,
  isPaused,
  isStopping,
  recordCamera,
  cameraDeviceId,
  onRefresh,
}: CapturePreviewStageProps) {
  const isActive = isRecording || isPaused || isStopping;
  const cornerBase =
    'absolute h-7 w-7 border-[#5eead4] drop-shadow-[0_0_12px_rgba(94,234,212,0.55)]';

  return (
    <div className="relative flex h-full min-h-0 flex-col pt-[clamp(22px,4vw,48px)] px-[clamp(20px,5vw,68px)] pb-[136px] [-webkit-app-region:no-drag] max-[720px]:pt-[22px] max-[720px]:px-4 max-[720px]:pb-[160px]">
      <div className="pointer-events-none absolute inset-y-0 left-0 w-[40%] opacity-[0.45] bg-[linear-gradient(90deg,rgba(16,185,129,0.16),transparent_74%)]" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-[40%] opacity-[0.45] bg-[linear-gradient(270deg,rgba(56,189,248,0.12),transparent_74%)]" />

      <div className="relative z-[2] flex items-start justify-between gap-5 pl-14 max-[720px]:pl-0">
        <div>
          <p className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.12em] text-white/55">
            {isActive ? 'Capture live' : 'Capture setup'}
          </p>
          <h1 className="m-0 text-[clamp(42px,6vw,88px)] font-['Instrument_Serif',serif] font-normal italic leading-[0.94] text-white/95">
            {isActive ? 'Recording' : 'New recording'}
          </h1>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={isLoading || isActive}
          className="mt-2 border border-white/10 bg-white/5 text-white/70 backdrop-blur-[14px] max-[720px]:hidden"
        >
          <RefreshCw className={cn('size-4', isLoading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      <div className="relative z-[2] grid flex-1 min-h-0 place-items-center pt-[18px] pb-[22px]">
        {selectedSource ? (
          <div className="w-[min(1040px,78vw)] max-[720px]:w-[min(100%,92vw)]">
            <div
              className={cn(
                'relative grid aspect-video w-full max-h-[min(64vh,640px)] place-items-center overflow-visible rounded-[18px] border border-white/15 bg-black/45 shadow-[0_0_0_1px_rgba(16,185,129,0.28),0_30px_90px_rgba(0,0,0,0.48),0_0_80px_rgba(16,185,129,0.14)]',
                isActive &&
                  'shadow-[0_0_0_1px_rgba(239,68,68,0.72),0_30px_90px_rgba(0,0,0,0.48),0_0_96px_rgba(239,68,68,0.18)]',
              )}
            >
              {selectedSource.thumbnailDataUrl ? (
                <img
                  src={selectedSource.thumbnailDataUrl}
                  alt={selectedSource.name}
                  className="block max-h-full max-w-full rounded-[15px] object-contain"
                />
              ) : (
                <div className="grid h-full w-full place-items-center text-white/30">
                  {selectedSource.isScreen ? <Monitor size={72} /> : <AppWindow size={72} />}
                </div>
              )}
              <span
                className={cn(
                  cornerBase,
                  isActive && 'border-[#f87171] drop-shadow-[0_0_12px_rgba(248,113,113,0.55)]',
                  'left-[-7px] top-[-7px] rounded-tl-[18px] border-l-2 border-t-2',
                )}
              />
              <span
                className={cn(
                  cornerBase,
                  isActive && 'border-[#f87171] drop-shadow-[0_0_12px_rgba(248,113,113,0.55)]',
                  'right-[-7px] top-[-7px] rounded-tr-[18px] border-r-2 border-t-2',
                )}
              />
              <span
                className={cn(
                  cornerBase,
                  isActive && 'border-[#f87171] drop-shadow-[0_0_12px_rgba(248,113,113,0.55)]',
                  'bottom-[-7px] left-[-7px] rounded-bl-[18px] border-b-2 border-l-2',
                )}
              />
              <span
                className={cn(
                  cornerBase,
                  isActive && 'border-[#f87171] drop-shadow-[0_0_12px_rgba(248,113,113,0.55)]',
                  'bottom-[-7px] right-[-7px] rounded-br-[18px] border-b-2 border-r-2',
                )}
              />
              <CameraPreview
                deviceId={cameraDeviceId}
                isActive={recordCamera}
                className="absolute bottom-[clamp(14px,2.2vw,28px)] right-[clamp(14px,2.2vw,28px)] z-[3] w-[clamp(92px,12vw,156px)] border-white/35"
              />
            </div>
          </div>
        ) : (
          <div className="grid w-[min(560px,calc(100vw-48px))] min-h-[300px] place-items-center content-center gap-[18px] rounded-[20px] border border-dashed border-white/15 bg-white/[0.035] text-white/65">
            <div className="grid h-[70px] w-[70px] place-items-center rounded-[18px] border border-white/10 bg-white/[0.06]">
              {isLoading ? <RefreshCw className="animate-spin" size={34} /> : <Monitor size={34} />}
            </div>
            <h2 className="m-0 text-[18px] font-[650] text-white/85">
              {isLoading ? 'Scanning sources' : 'Choose a capture source'}
            </h2>
          </div>
        )}
      </div>

      {selectedSource && (
        <div className="absolute bottom-[146px] right-[clamp(18px,5vw,68px)] z-[3] flex max-w-[min(620px,calc(100vw-36px))] items-center gap-2.5 overflow-hidden rounded-full border border-white/10 bg-[rgba(10,12,12,0.72)] px-3 py-2 text-[12px] text-white/60 shadow-[0_18px_52px_rgba(0,0,0,0.32)] backdrop-blur-[18px] max-[720px]:bottom-[168px] max-[720px]:left-4 max-[720px]:right-4">
          <span
            className={cn(
              'h-2 w-2 flex-none rounded-full bg-emerald-400 shadow-[0_0_0_4px_rgba(52,211,153,0.12)]',
              isPaused && 'bg-yellow-400',
            )}
          />
          <span>{selectedSource.isScreen ? 'Screen' : 'Window'}</span>
          <strong className="min-w-0 truncate font-[650] text-white/90">
            {selectedSource.name}
          </strong>
          {selectedSource.width && selectedSource.height && (
            <span>
              {selectedSource.width} x {selectedSource.height}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
