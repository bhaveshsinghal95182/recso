import { ChevronDown, FolderOpen, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

import { QualitySelector } from './quality-selector';

type VideoCodec = 'H264' | 'Hevc' | 'Vp9';

interface SettingsPanelProps {
  outputDir: string;
  fileName: string;
  videoBitrate: number;
  codec: VideoCodec;
  onOutputDirChange: (path: string) => void;
  onFileNameChange: (name: string) => void;
  onVideoBitrateChange: (bitrate: number) => void;
  onCodecChange: (codec: VideoCodec) => void;
}

export function SettingsPanel({
  outputDir,
  fileName,
  videoBitrate,
  codec,
  onOutputDirChange,
  onFileNameChange,
  onVideoBitrateChange,
  onCodecChange,
}: SettingsPanelProps) {
  const [isValid, setIsValid] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Validate output path on change
  useEffect(() => {
    const validate = async () => {
      const result = await window.electron.recorder.validateOutputPath(outputDir);
      setIsValid(result.valid);
    };
    if (outputDir) validate();
  }, [outputDir]);

  const handleBrowse = async () => {
    const selectedPath = await window.electron.recorder.showOpenDialog();
    if (selectedPath) {
      onOutputDirChange(selectedPath);
    }
  };

  return (
    <Card className="border-0 shadow-none bg-transparent p-0">
      <CardContent className="space-y-4 p-0">
        <div className="space-y-2">
          <Label htmlFor="fileName">File Name</Label>
          <Input
            id="fileName"
            value={fileName}
            onChange={(e) => onFileNameChange(e.target.value)}
            placeholder="recording_name"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="outputDir">Output Folder</Label>
          <div className="flex gap-2">
            <Input
              id="outputDir"
              value={outputDir}
              readOnly
              className={cn(!isValid && 'border-red-500 bg-red-50')}
              title={outputDir}
            />
            <Button
              variant="outline"
              size="icon"
              onClick={handleBrowse}
              title="Select Output Folder"
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          </div>
          {!isValid && (
            <p className="text-xs text-red-500">Invalid directory or no write permission.</p>
          )}
        </div>

        {/* Advanced Settings Toggle */}
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-full pt-2"
        >
          <Settings size={14} />
          <span>Advanced Settings</span>
          <ChevronDown
            size={14}
            className={cn('ml-auto transition-transform', showAdvanced && 'rotate-180')}
          />
        </button>

        {/* Advanced Settings Content */}
        <div
          className={cn(
            'overflow-hidden transition-all duration-200',
            showAdvanced ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0',
          )}
        >
          <div className="space-y-4 pt-2 border-t border-border/50">
            {/* Codec Selector */}
            <div className="space-y-2">
              <Label>Video Codec</Label>
              <div className="flex gap-2">
                {(['H264', 'Hevc', 'Vp9'] as VideoCodec[]).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => onCodecChange(c)}
                    className={cn(
                      'flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors border',
                      codec === c
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card hover:bg-muted border-border',
                    )}
                  >
                    {c === 'H264' ? 'H.264' : c === 'Hevc' ? 'H.265' : 'VP9'}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {codec === 'H264' && 'Best compatibility, works on all devices'}
                {codec === 'Hevc' && 'Better compression, smaller files, newer devices'}
                {codec === 'Vp9' && 'Open codec, great for web'}
              </p>
            </div>

            {/* Quality/Bitrate Selector */}
            <div className="space-y-2">
              <QualitySelector value={videoBitrate} onChange={onVideoBitrateChange} />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
