import { Mic, Video, Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

import { QualitySelector } from './quality-selector';

interface SettingsPanelProps {
  outputDir: string;
  fileName: string;
  videoBitrate: number;
  format: string;
  recordMic: boolean;
  recordCamera: boolean;
  recordSystemAudio: boolean;
  cameraDeviceId: string | null;
  micDeviceId: string | null;
  cameras: MediaDeviceInfo[];
  microphones: MediaDeviceInfo[];
  onOutputDirChange: (path: string) => void;
  onFileNameChange: (name: string) => void;
  onVideoBitrateChange: (bitrate: number) => void;
  onFormatChange: (format: string) => void;
  onRecordMicChange: (enabled: boolean) => void;
  onRecordCameraChange: (enabled: boolean) => void;
  onRecordSystemAudioChange: (enabled: boolean) => void;
  onCameraDeviceChange: (deviceId: string) => void;
  onMicDeviceChange: (deviceId: string) => void;
}

export function SettingsPanel({
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
  onOutputDirChange,
  onFileNameChange,
  onVideoBitrateChange,
  onRecordMicChange,
  onRecordCameraChange,
  onRecordSystemAudioChange,
  onCameraDeviceChange,
  onMicDeviceChange,
}: SettingsPanelProps) {
  const [isValid, setIsValid] = useState(true);
  // const [supportId, setSupportId] = useState<string>('');
  // const [copied, setCopied] = useState(false);

  // Validate output path on change
  useEffect(() => {
    const validate = async () => {
      const result = await window.electron.recorder.validateOutputPath(outputDir);
      setIsValid(result.valid);
    };
    if (outputDir) validate();
  }, [outputDir]);

  // Fetch support ID on mount
  // useEffect(() => {
  // window.electron.telemetry.getSupportId().then(setSupportId).catch(console.error);
  // }, []);

  const handleBrowse = async () => {
    const selectedPath = await window.electron.recorder.showOpenDialog();
    if (selectedPath) {
      onOutputDirChange(selectedPath);
    }
  };

  // const handleCopySupportId = async () => {
  //   if (!supportId) return;
  //   await navigator.clipboard.writeText(supportId);
  //   setCopied(true);
  //   setTimeout(() => setCopied(false), 2000);
  // };

  return (
    <Card className="border-0 shadow-none bg-transparent p-0">
      <CardContent className="space-y-5 p-0">
        <div className="space-y-2">
          <Label htmlFor="fileName" className="text-foreground/60">
            File Name
          </Label>
          <Input
            id="fileName"
            value={fileName}
            onChange={(e) => onFileNameChange(e.target.value)}
            placeholder="recording_name"
            className="shadow-s!"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="outputDir" className="text-foreground/60">
            Output Folder
          </Label>
          <div className="flex gap-2">
            {/* <Input
              id="outputDir"
              value={outputDir}
              readOnly
              className={cn(!isValid && 'border-red-500 bg-red-50')}
              title={outputDir}
            /> */}
            <Button
              variant="outline"
              size="default"
              onClick={handleBrowse}
              title="Select Output Folder"
              className="w-full justify-between shadow-m! border-none"
            >
              {outputDir}
            </Button>
          </div>
          {!isValid && (
            <p className="text-xs text-red-500">Invalid directory or no write permission.</p>
          )}
        </div>

        {/* Add-on Devices */}
        {/* Microphone Card */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Mic size={16} className={cn('text-muted-foreground', recordMic && 'text-brand')} />
              <Label htmlFor="record-mic" className="cursor-pointer">
                Microphone
              </Label>
            </div>
            <Switch id="record-mic" checked={recordMic} onCheckedChange={onRecordMicChange} />
          </div>
          {recordMic && microphones.length > 0 && (
            <Select
              value={micDeviceId || microphones[0]?.deviceId}
              onValueChange={(val) => val && onMicDeviceChange(val)}
            >
              <SelectTrigger className="h-8 text-xs shadow-s">
                <SelectValue placeholder="Select Microphone" />
              </SelectTrigger>
              <SelectContent className="w-full">
                {microphones.map((mic) => (
                  <SelectItem key={mic.deviceId} value={mic.deviceId}>
                    {mic.label || 'Default Microphone'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Camera Card */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Video
                size={16}
                className={cn('text-muted-foreground', recordCamera && 'text-brand')}
              />
              <Label htmlFor="record-cam" className="cursor-pointer">
                Webcam
              </Label>
            </div>
            <Switch id="record-cam" checked={recordCamera} onCheckedChange={onRecordCameraChange} />
          </div>
          {recordCamera && cameras.length > 0 && (
            <Select
              value={cameraDeviceId || cameras[0]?.deviceId}
              onValueChange={(val) => val && onCameraDeviceChange(val)}
            >
              <SelectTrigger className="h-8 w-50 text-xs shadow-s">
                <SelectValue placeholder="Select Camera" />
              </SelectTrigger>
              <SelectContent className="w-full">
                {cameras.map((cam) => (
                  <SelectItem key={cam.deviceId} value={cam.deviceId}>
                    {cam.label || 'Default Camera'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* System Audio Card */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Volume2
                size={16}
                className={cn('text-muted-foreground', recordSystemAudio && 'text-brand')}
              />
              <Label htmlFor="record-system-audio" className="cursor-pointer">
                System Audio
              </Label>
            </div>
            <Switch
              id="record-system-audio"
              checked={recordSystemAudio}
              onCheckedChange={onRecordSystemAudioChange}
            />
          </div>
        </div>

        <QualitySelector value={videoBitrate} onChange={onVideoBitrateChange} />
        {/* <FormatSelector value={format} onChange={onFormatChange} /> */}

        {/* Support ID */}
        {/* {supportId && (
          <div className="pt-3 border-t border-border/50">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Support ID</p>
                <code className="text-xs font-mono text-foreground/80">{supportId}</code>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={handleCopySupportId}
                title="Copy Support ID"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </div>
        )} */}
      </CardContent>
    </Card>
  );
}
