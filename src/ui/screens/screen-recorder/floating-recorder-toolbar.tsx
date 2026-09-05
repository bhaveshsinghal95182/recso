import {
  AppWindow,
  Check,
  ChevronUp,
  Folder,
  Loader2,
  Mic,
  MicOff,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  Settings2,
  Square,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { quality } from '@/constants';
import { cn, formatBytes, formatDuration } from '@/lib/utils';
import type { DesktopSource } from '@/types';

import { PhoneCameraPanel } from './phone-camera-panel';

type ToolbarPanel = 'sources' | 'microphone' | 'camera' | 'settings';
type SourceFilter = 'all' | 'screen' | 'window';

const panelSurface =
  'border border-white/15 bg-[linear-gradient(180deg,rgba(255,255,255,0.1),transparent_58%),rgba(12,14,14,0.82)] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_24px_70px_rgba(0,0,0,0.52)] backdrop-blur-[24px]';
const iconButtonBase =
  'grid place-items-center w-[46px] h-[46px] flex-none cursor-pointer rounded-[16px] border border-white/10 bg-white/[0.055] text-white/70 transition duration-150 hover:border-white/20 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50';

interface FloatingRecorderToolbarProps {
  sources: DesktopSource[];
  selectedSourceId: string | null;
  selectedSource: DesktopSource | undefined;
  isLoading: boolean;
  isRecording: boolean;
  isPaused: boolean;
  isStopping: boolean;
  isStarting: boolean;
  duration: number;
  bytesWritten: number;
  outputDir: string;
  fileName: string;
  videoBitrate: number;
  recordMic: boolean;
  recordCamera: boolean;
  recordSystemAudio: boolean;
  cameraDeviceId: string | null;
  micDeviceId: string | null;
  cameras: MediaDeviceInfo[];
  microphones: MediaDeviceInfo[];
  onSourceSelect: (id: string) => void;
  onRefreshSources: () => Promise<DesktopSource[]> | DesktopSource[] | void;
  setIsLoading: (loading: boolean) => void;
  onOutputDirChange: (path: string) => void;
  onFileNameChange: (name: string) => void;
  onVideoBitrateChange: (bitrate: number) => void;
  onRecordMicChange: (enabled: boolean) => void;
  onRecordCameraChange: (enabled: boolean) => void;
  onRecordSystemAudioChange: (enabled: boolean) => void;
  onCameraDeviceChange: (deviceId: string) => void;
  /** Where the camera picture comes from: this machine, or a paired phone. */
  cameraSource: 'local' | 'phone';
  onCameraSourceChange: (source: 'local' | 'phone') => void;
  /** Microphones as the native recorder sees them; its ids are what it opens. */
  nativeMicrophones: Array<{ id: string; label: string; isDefault: boolean }>;
  nativeMicDeviceId: string | null;
  onNativeMicDeviceChange: (deviceId: string) => void;
  onMicDeviceChange: (deviceId: string) => void;
  onStart: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
}

export function FloatingRecorderToolbar({
  sources,
  selectedSourceId,
  selectedSource,
  isLoading,
  isRecording,
  isPaused,
  isStopping,
  isStarting,
  duration,
  bytesWritten,
  outputDir,
  fileName,
  videoBitrate,
  recordMic,
  recordCamera,
  recordSystemAudio,
  cameraDeviceId,
  micDeviceId,
  cameras,
  microphones,
  onSourceSelect,
  onRefreshSources,
  setIsLoading,
  onOutputDirChange,
  onFileNameChange,
  onVideoBitrateChange,
  onRecordMicChange,
  onRecordCameraChange,
  onRecordSystemAudioChange,
  onCameraDeviceChange,
  cameraSource,
  onCameraSourceChange,
  nativeMicrophones,
  nativeMicDeviceId,
  onNativeMicDeviceChange,
  onMicDeviceChange,
  onStart,
  onStop,
  onPause,
  onResume,
}: FloatingRecorderToolbarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [openPanel, setOpenPanel] = useState<ToolbarPanel | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [isOutputValid, setIsOutputValid] = useState(true);

  const isCaptureActive = isRecording || isPaused || isStopping;
  const controlsLocked = isCaptureActive || isStarting;
  const selectedQuality = useMemo(
    () => quality.find((option) => option.value === videoBitrate) ?? quality[1],
    [videoBitrate],
  );

  const filteredSources = useMemo(
    () =>
      sources.filter((source) => {
        if (sourceFilter === 'screen') return source.isScreen;
        if (sourceFilter === 'window') return !source.isScreen;
        return true;
      }),
    [sourceFilter, sources],
  );

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenPanel(null);
      }
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, []);

  useEffect(() => {
    if (controlsLocked) {
      setOpenPanel(null);
    }
  }, [controlsLocked]);

  useEffect(() => {
    let cancelled = false;

    if (!outputDir) {
      setIsOutputValid(false);
      return;
    }

    void window.electron.recorder
      .validateOutputPath(outputDir)
      .then((result) => {
        if (!cancelled) {
          setIsOutputValid(result.valid);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsOutputValid(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [outputDir]);

  const handleRefreshSources = async () => {
    setIsLoading(true);
    await onRefreshSources();
    setIsLoading(false);
  };

  const handleBrowseOutput = async () => {
    const selectedPath = await window.electron.recorder.showOpenDialog();
    if (selectedPath) {
      onOutputDirChange(selectedPath);
    }
  };

  const togglePanel = (panel: ToolbarPanel) => {
    if (controlsLocked) return;
    setOpenPanel((current) => (current === panel ? null : panel));
  };

  const toggleMic = () => {
    const next = !recordMic;
    onRecordMicChange(next);
    if (next && !micDeviceId && microphones[0]) {
      onMicDeviceChange(microphones[0].deviceId);
    }
  };

  const toggleCamera = () => {
    // The switch on the local device list. Turning it on also claims the source
    // back from a paired phone, since only one camera reaches the recording.
    const next = !(recordCamera && cameraSource === 'local');
    onCameraSourceChange('local');
    onRecordCameraChange(next);
    if (next && !cameraDeviceId && cameras[0]) {
      onCameraDeviceChange(cameras[0].deviceId);
    }
  };

  /**
   * The microphone list to show.
   *
   * The native one when it has anything, because native capture is what records
   * the sound now and it can only open devices from that list. The browser's is
   * the fallback for a machine where native enumeration found nothing, which is
   * anywhere that is not Windows.
   */
  const usingNativeMics = nativeMicrophones.length > 0;
  const micDevices = usingNativeMics
    ? nativeMicrophones.map(
        (device) =>
          ({
            deviceId: device.id,
            label: device.label,
            kind: 'audioinput',
            groupId: '',
          }) as MediaDeviceInfo,
      )
    : microphones;

  const canStart = Boolean(selectedSourceId && outputDir && fileName && isOutputValid);

  return (
    <div
      ref={rootRef}
      className="absolute bottom-7 left-1/2 z-50 w-[min(930px,calc(100vw-32px))] -translate-x-1/2 max-[720px]:bottom-4 [-webkit-app-region:no-drag]"
    >
      {openPanel && !controlsLocked && (
        <div
          className={cn(
            panelSurface,
            'absolute bottom-[calc(100%+12px)] left-1/2 w-[min(720px,calc(100vw-32px))] max-h-[min(560px,calc(100vh-178px))] -translate-x-1/2 overflow-hidden rounded-[22px] p-4 animate-in fade-in zoom-in-95 duration-150',
          )}
        >
          {openPanel === 'sources' && (
            <SourcePanel
              sources={filteredSources}
              allSources={sources}
              selectedSourceId={selectedSourceId}
              sourceFilter={sourceFilter}
              isLoading={isLoading}
              onSourceFilterChange={setSourceFilter}
              onRefresh={handleRefreshSources}
              onSourceSelect={(id) => {
                onSourceSelect(id);
                setOpenPanel(null);
              }}
            />
          )}
          {openPanel === 'microphone' && (
            <DevicePanel
              title="Microphone"
              enabled={recordMic}
              devices={micDevices}
              selectedDeviceId={usingNativeMics ? nativeMicDeviceId : micDeviceId}
              emptyLabel="No microphones found"
              fallbackLabel="Default microphone"
              activeIcon={<Mic size={18} />}
              inactiveIcon={<MicOff size={18} />}
              onToggle={toggleMic}
              onDeviceSelect={(deviceId) => {
                // Which id this is depends on which list produced it, and they
                // are not interchangeable -- a browser id means nothing to the
                // native recorder and vice versa.
                if (usingNativeMics) {
                  onNativeMicDeviceChange(deviceId);
                } else {
                  onMicDeviceChange(deviceId);
                }
                onRecordMicChange(true);
              }}
            />
          )}
          {openPanel === 'camera' && (
            <div className="flex flex-col gap-4">
              <DevicePanel
                title="Webcam"
                enabled={recordCamera && cameraSource === 'local'}
                devices={cameras}
                selectedDeviceId={cameraDeviceId}
                emptyLabel="No webcams found"
                fallbackLabel="Default webcam"
                activeIcon={<Video size={18} />}
                inactiveIcon={<VideoOff size={18} />}
                onToggle={toggleCamera}
                onDeviceSelect={(deviceId) => {
                  onCameraDeviceChange(deviceId);
                  onCameraSourceChange('local');
                  onRecordCameraChange(true);
                }}
              />
              <PhoneCameraPanel
                active={recordCamera && cameraSource === 'phone'}
                onActivate={() => {
                  onCameraSourceChange('phone');
                  onRecordCameraChange(true);
                }}
                onDeactivate={() => {
                  onCameraSourceChange('local');
                  onRecordCameraChange(false);
                }}
              />
            </div>
          )}
          {openPanel === 'settings' && (
            <SettingsPanel
              outputDir={outputDir}
              fileName={fileName}
              selectedQualityLabel={selectedQuality.label}
              videoBitrate={videoBitrate}
              isOutputValid={isOutputValid}
              onOutputBrowse={handleBrowseOutput}
              onFileNameChange={onFileNameChange}
              onVideoBitrateChange={onVideoBitrateChange}
            />
          )}
        </div>
      )}

      <div
        className={cn(
          panelSurface,
          'flex min-h-[76px] items-center gap-2 rounded-[24px] p-[10px] max-[980px]:overflow-x-auto max-[720px]:min-h-0 max-[720px]:rounded-[20px]',
        )}
      >
        {isCaptureActive ? (
          <RecordingBar
            isPaused={isPaused}
            isStopping={isStopping}
            duration={duration}
            bytesWritten={bytesWritten}
            onPause={onPause}
            onResume={onResume}
            onStop={onStop}
          />
        ) : (
          <>
            <ToolbarButton
              label={selectedSource?.isScreen ? 'Screen' : selectedSource ? 'Window' : 'Source'}
              value={selectedSource?.name ?? 'Choose source'}
              icon={selectedSource?.isScreen ? <Monitor size={18} /> : <AppWindow size={18} />}
              isOpen={openPanel === 'sources'}
              disabled={isStarting}
              wide
              onClick={() => togglePanel('sources')}
            />

            <div className="h-[42px] w-px flex-none bg-white/10" />

            <ToolbarButton
              label="Mic"
              value={recordMic ? deviceName(microphones, micDeviceId, 'On') : 'Off'}
              icon={recordMic ? <Mic size={18} /> : <MicOff size={18} />}
              active={recordMic}
              isOpen={openPanel === 'microphone'}
              disabled={isStarting}
              onClick={() => togglePanel('microphone')}
            />

            <ToolbarButton
              label="Webcam"
              value={recordCamera ? deviceName(cameras, cameraDeviceId, 'On') : 'Off'}
              icon={recordCamera ? <Video size={18} /> : <VideoOff size={18} />}
              active={recordCamera}
              isOpen={openPanel === 'camera'}
              disabled={isStarting}
              onClick={() => togglePanel('camera')}
            />

            <button
              type="button"
              className={cn(
                iconButtonBase,
                recordSystemAudio && 'border-emerald-400/40 bg-emerald-400/15 text-emerald-200',
              )}
              onClick={() => onRecordSystemAudioChange(!recordSystemAudio)}
              disabled={isStarting}
              title={recordSystemAudio ? 'System audio on' : 'System audio off'}
              aria-label={recordSystemAudio ? 'Turn system audio off' : 'Turn system audio on'}
            >
              {recordSystemAudio ? <Volume2 size={18} /> : <VolumeX size={18} />}
            </button>

            <button
              type="button"
              className={cn(
                iconButtonBase,
                openPanel === 'settings' && 'border-white/20 bg-white/10 text-white',
              )}
              onClick={() => togglePanel('settings')}
              disabled={isStarting}
              title="Recording settings"
              aria-label="Recording settings"
            >
              <Settings2 size={18} />
            </button>

            <button
              type="button"
              className="ml-auto grid h-14 w-14 flex-none cursor-pointer place-items-center rounded-[19px] bg-[linear-gradient(180deg,#ff6b6b,#dc2626)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.32),0_12px_30px_rgba(220,38,38,0.36)] transition duration-150 hover:-translate-y-[1px] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onStart}
              disabled={!canStart || isStarting}
              title={canStart ? 'Start recording' : 'Select source and output'}
              aria-label="Start recording"
            >
              {isStarting ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <span className="h-[19px] w-[19px] rounded-full bg-white" />
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function RecordingBar({
  isPaused,
  isStopping,
  duration,
  bytesWritten,
  onPause,
  onResume,
  onStop,
}: {
  isPaused: boolean;
  isStopping: boolean;
  duration: number;
  bytesWritten: number;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  return (
    <div className="flex w-full items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-3 rounded-[18px] border border-white/10 bg-black/25 px-4 py-3.5 text-[13px] text-white/60">
        {isStopping ? (
          <Loader2 size={14} className="flex-none animate-spin text-white/70" />
        ) : (
          <span
            className={cn(
              'h-2 w-2 flex-none rounded-full bg-red-500 shadow-[0_0_0_4px_rgba(239,68,68,0.14)]',
              isPaused && 'bg-yellow-400',
            )}
          />
        )}
        <span>{isStopping ? 'Finishing up' : isPaused ? 'Paused' : 'Recording'}</span>
        <strong className="font-mono text-[22px] font-[750] tabular-nums text-white">
          {formatDuration(duration)}
        </strong>
        <span>{formatBytes(bytesWritten, 1)}</span>
      </div>
      <button
        type="button"
        className={cn(iconButtonBase, isStopping && 'pointer-events-none opacity-40')}
        onClick={isPaused ? onResume : onPause}
        disabled={isStopping}
        title={isPaused ? 'Resume recording' : 'Pause recording'}
        aria-label={isPaused ? 'Resume recording' : 'Pause recording'}
      >
        {isPaused ? <Play size={18} /> : <Pause size={18} />}
      </button>
      <button
        type="button"
        className={cn(
          'grid h-14 w-14 flex-none place-items-center rounded-[19px] bg-[linear-gradient(180deg,#fb7185,#e11d48)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.32),0_12px_30px_rgba(225,29,72,0.34)] transition duration-150',
          isStopping
            ? 'cursor-default opacity-60'
            : 'cursor-pointer hover:-translate-y-[1px] hover:brightness-110',
        )}
        onClick={onStop}
        disabled={isStopping}
        title={isStopping ? 'Finishing up…' : 'Stop recording'}
        aria-label={isStopping ? 'Finishing up' : 'Stop recording'}
      >
        {isStopping ? (
          <Loader2 size={18} className="animate-spin" />
        ) : (
          <Square size={17} fill="currentColor" />
        )}
      </button>
    </div>
  );
}

function ToolbarButton({
  icon,
  label,
  value,
  active,
  isOpen,
  disabled,
  wide,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  active?: boolean;
  isOpen?: boolean;
  disabled?: boolean;
  wide?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        'grid h-14 min-w-[122px] max-w-[172px] grid-cols-[30px_minmax(0,1fr)_14px] items-center gap-[9px] rounded-[17px] border border-transparent bg-transparent px-[9px] py-2 text-left text-white/70 transition duration-150 cursor-pointer hover:border-white/10 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50',
        active && 'text-emerald-200',
        isOpen && 'border-white/10 bg-white/10 text-white',
        wide && 'min-w-[230px] max-w-[290px] max-[980px]:min-w-[198px]',
      )}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="grid h-[30px] w-[30px] place-items-center rounded-[11px] bg-white/[0.07]">
        {icon}
      </span>
      <span className="grid min-w-0 gap-[2px]">
        <span className="text-[10px] font-[750] uppercase tracking-[0.1em] text-white/50">
          {label}
        </span>
        <strong className="truncate text-[13px] font-[650] text-white/90" title={value}>
          {value}
        </strong>
      </span>
      <ChevronUp
        className={cn('text-white/40 transition-transform', isOpen && 'rotate-180')}
        size={14}
      />
    </button>
  );
}

function SourcePanel({
  sources,
  allSources,
  selectedSourceId,
  sourceFilter,
  isLoading,
  onSourceFilterChange,
  onRefresh,
  onSourceSelect,
}: {
  sources: DesktopSource[];
  allSources: DesktopSource[];
  selectedSourceId: string | null;
  sourceFilter: SourceFilter;
  isLoading: boolean;
  onSourceFilterChange: (filter: SourceFilter) => void;
  onRefresh: () => void;
  onSourceSelect: (id: string) => void;
}) {
  const screensCount = allSources.filter((source) => source.isScreen).length;
  const windowsCount = allSources.length - screensCount;

  return (
    <div className="flex flex-col">
      <div className="mb-[14px] flex items-center justify-between gap-4">
        <div>
          <p className="mb-1 text-[10px] font-[750] uppercase tracking-[0.1em] text-white/50">
            Capture source
          </p>
          <strong className="text-[15px] font-[700] text-white/90">
            {allSources.length} available
          </strong>
        </div>
        <button
          type="button"
          className={iconButtonBase}
          onClick={onRefresh}
          disabled={isLoading}
          title="Refresh sources"
          aria-label="Refresh sources"
        >
          <RefreshCw className={cn('size-4', isLoading && 'animate-spin')} />
        </button>
      </div>

      <div className="mb-3 flex gap-1.5 rounded-[14px] bg-black/25 p-[5px]">
        <FilterButton
          active={sourceFilter === 'all'}
          label="All"
          count={allSources.length}
          onClick={() => onSourceFilterChange('all')}
        />
        <FilterButton
          active={sourceFilter === 'screen'}
          label="Screens"
          count={screensCount}
          onClick={() => onSourceFilterChange('screen')}
        />
        <FilterButton
          active={sourceFilter === 'window'}
          label="Windows"
          count={windowsCount}
          onClick={() => onSourceFilterChange('window')}
        />
      </div>

      <div className="grid max-h-[360px] grid-cols-2 gap-2.5 overflow-auto pr-0.5 max-[980px]:grid-cols-1">
        {isLoading ? (
          <div className="grid min-h-[126px] place-items-center content-center gap-2.5 rounded-[16px] border border-dashed border-white/15 text-[13px] font-[650] text-white/50">
            <RefreshCw className="animate-spin" size={22} />
            <span>Scanning sources</span>
          </div>
        ) : sources.length === 0 ? (
          <div className="grid min-h-[126px] place-items-center content-center gap-2.5 rounded-[16px] border border-dashed border-white/15 text-[13px] font-[650] text-white/50">
            <Monitor size={22} />
            <span>No sources found</span>
          </div>
        ) : (
          sources.map((source) => (
            <button
              key={source.id}
              type="button"
              className={cn(
                'grid min-w-0 grid-cols-[96px_minmax(0,1fr)_18px] items-center gap-3 rounded-[16px] border border-white/10 bg-white/[0.045] p-2 text-left text-white/70 transition duration-150 cursor-pointer hover:border-[#5eead4]/35 hover:bg-emerald-500/15 hover:text-[#ccfbf1]',
                selectedSourceId === source.id &&
                  'border-[#5eead4]/35 bg-emerald-500/15 text-[#ccfbf1]',
              )}
              onClick={() => onSourceSelect(source.id)}
            >
              <span className="grid aspect-video place-items-center overflow-hidden rounded-[11px] bg-black/40 text-white/30">
                {source.thumbnailDataUrl ? (
                  <img
                    src={source.thumbnailDataUrl}
                    alt=""
                    className="h-full w-full object-contain"
                  />
                ) : source.isScreen ? (
                  <Monitor size={30} />
                ) : (
                  <AppWindow size={30} />
                )}
              </span>
              <span className="grid min-w-0 gap-[3px]">
                <span className="text-[11px] text-white/45">
                  {source.isScreen ? 'Screen' : 'Window'}
                </span>
                <strong
                  className="truncate text-[13px] font-[650] text-white/90"
                  title={source.name}
                >
                  {source.name}
                </strong>
              </span>
              {selectedSourceId === source.id && <Check className="size-4" />}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function DevicePanel({
  title,
  enabled,
  devices,
  selectedDeviceId,
  emptyLabel,
  fallbackLabel,
  activeIcon,
  inactiveIcon,
  onToggle,
  onDeviceSelect,
}: {
  title: string;
  enabled: boolean;
  devices: MediaDeviceInfo[];
  selectedDeviceId: string | null;
  emptyLabel: string;
  fallbackLabel: string;
  activeIcon: ReactNode;
  inactiveIcon: ReactNode;
  onToggle: () => void;
  onDeviceSelect: (deviceId: string) => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="mb-[14px] flex items-center justify-between gap-4">
        <div>
          <p className="mb-1 text-[10px] font-[750] uppercase tracking-[0.1em] text-white/50">
            {title}
          </p>
          <strong className="text-[15px] font-[700] text-white/90">{enabled ? 'On' : 'Off'}</strong>
        </div>
        <button
          type="button"
          className={cn(
            'flex items-center gap-2 rounded-[14px] border border-white/10 bg-white/[0.055] px-3 py-2 text-[13px] font-[700] text-white/70 transition duration-150 cursor-pointer hover:border-white/20 hover:bg-white/10 hover:text-white',
            enabled && 'border-emerald-400/40 bg-emerald-400/15 text-emerald-200',
          )}
          onClick={onToggle}
        >
          {enabled ? activeIcon : inactiveIcon}
          <span>{enabled ? 'Enabled' : 'Disabled'}</span>
        </button>
      </div>

      <div className="grid max-h-[300px] gap-2 overflow-auto">
        {devices.length === 0 ? (
          <div className="grid min-h-[126px] place-items-center content-center gap-2.5 rounded-[16px] border border-dashed border-white/15 text-[13px] font-[650] text-white/50">
            {inactiveIcon}
            <span>{emptyLabel}</span>
          </div>
        ) : (
          devices.map((device, index) => {
            const isSelected =
              selectedDeviceId === device.deviceId || (!selectedDeviceId && index === 0);

            return (
              <button
                key={device.deviceId || `${title}-${index}`}
                type="button"
                className={cn(
                  'grid grid-cols-[24px_minmax(0,1fr)_18px] items-center gap-2.5 rounded-[14px] border border-white/10 bg-white/[0.045] px-3 py-2.5 text-left text-white/70 transition duration-150 cursor-pointer hover:border-[#5eead4]/35 hover:bg-emerald-500/15 hover:text-[#ccfbf1]',
                  enabled && isSelected && 'border-[#5eead4]/35 bg-emerald-500/15 text-[#ccfbf1]',
                )}
                onClick={() => onDeviceSelect(device.deviceId)}
              >
                <span>{enabled ? activeIcon : inactiveIcon}</span>
                <strong className="truncate text-[13px] font-[650]">
                  {device.label || fallbackLabel}
                </strong>
                {enabled && isSelected && <Check className="size-4" />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function SettingsPanel({
  outputDir,
  fileName,
  selectedQualityLabel,
  videoBitrate,
  isOutputValid,
  onOutputBrowse,
  onFileNameChange,
  onVideoBitrateChange,
}: {
  outputDir: string;
  fileName: string;
  selectedQualityLabel: string;
  videoBitrate: number;
  isOutputValid: boolean;
  onOutputBrowse: () => void;
  onFileNameChange: (name: string) => void;
  onVideoBitrateChange: (bitrate: number) => void;
}) {
  return (
    <div className="grid gap-3.5">
      <div className="mb-[14px] flex items-center justify-between gap-4">
        <div>
          <p className="mb-1 text-[10px] font-[750] uppercase tracking-[0.1em] text-white/50">
            Recording settings
          </p>
          <strong className="text-[15px] font-[700] text-white/90">{selectedQualityLabel}</strong>
        </div>
      </div>

      <label className="grid gap-[7px]">
        <span className="text-[10px] font-[750] uppercase tracking-[0.1em] text-white/50">
          File name
        </span>
        <Input
          value={fileName}
          onChange={(event) => onFileNameChange(event.target.value)}
          className="h-[42px] border-white/10 bg-black/20"
        />
      </label>

      <div className="grid gap-[7px]">
        <span className="text-[10px] font-[750] uppercase tracking-[0.1em] text-white/50">
          Output folder
        </span>
        <Button
          type="button"
          variant="outline"
          className={cn(
            'grid h-[42px] grid-cols-[18px_minmax(0,1fr)] justify-start border-white/10 bg-black/20 text-white/80',
            !isOutputValid && 'border-red-500/80 text-red-200',
          )}
          onClick={onOutputBrowse}
        >
          <Folder className="size-4" />
          <span className="truncate" title={outputDir}>
            {outputDir || 'Choose folder'}
          </span>
        </Button>
        {!isOutputValid && (
          <small className="text-[12px] text-red-300">
            Invalid directory or no write permission.
          </small>
        )}
      </div>

      <div className="grid grid-cols-4 gap-2 max-[720px]:grid-cols-2">
        {quality.map((option) => (
          <button
            key={option.value}
            type="button"
            className={cn(
              'grid gap-1 rounded-[14px] border border-white/10 bg-white/[0.045] p-2.5 text-left text-white/60 transition duration-150 cursor-pointer hover:border-[#5eead4]/35 hover:bg-emerald-500/15 hover:text-[#ccfbf1]',
              videoBitrate === option.value &&
                'border-[#5eead4]/35 bg-emerald-500/15 text-[#ccfbf1]',
            )}
            onClick={() => onVideoBitrateChange(option.value)}
          >
            <span className="text-[13px] font-[750]">{option.label.split(' (')[0]}</span>
            <strong className="text-[11px] font-[650] text-white/50">
              {option.label.match(/\((.*?)\)/)?.[1] ?? ''}
            </strong>
          </button>
        ))}
      </div>
    </div>
  );
}

function FilterButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        'flex flex-1 items-center justify-center gap-[7px] rounded-[10px] px-[10px] py-2 text-white/55 cursor-pointer',
        active && 'bg-white/10 text-white',
      )}
      onClick={onClick}
    >
      <span className="text-[12px] font-[700]">{label}</span>
      <strong className="text-[11px] text-white/60">{count}</strong>
    </button>
  );
}

function deviceName(devices: MediaDeviceInfo[], selectedDeviceId: string | null, fallback: string) {
  const selectedDevice = selectedDeviceId
    ? devices.find((device) => device.deviceId === selectedDeviceId)
    : devices[0];

  return selectedDevice?.label || fallback;
}
