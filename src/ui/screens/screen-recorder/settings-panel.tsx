import { ChevronDown, FolderOpen, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

import { FormatSelector } from './format-selector';
import { QualitySelector } from './quality-selector';

interface SettingsPanelProps {
  outputDir: string;
  fileName: string;
  videoBitrate: number;
  format: string;
  onOutputDirChange: (path: string) => void;
  onFileNameChange: (name: string) => void;
  onVideoBitrateChange: (bitrate: number) => void;
  onFormatChange: (format: string) => void;
}

export function SettingsPanel({
  outputDir,
  fileName,
  videoBitrate,
  format,
  onOutputDirChange,
  onFileNameChange,
  onVideoBitrateChange,
  onFormatChange,
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
            {/* Quality/Bitrate Selector */}
            <div className="space-y-4">
              <QualitySelector value={videoBitrate} onChange={onVideoBitrateChange} />
              <FormatSelector value={format} onChange={onFormatChange} />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
