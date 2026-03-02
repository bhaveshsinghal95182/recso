import { Check, ChevronDown, Copy, FolderOpen, Settings } from 'lucide-react';
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
  const [supportId, setSupportId] = useState<string>('');
  const [copied, setCopied] = useState(false);

  // Validate output path on change
  useEffect(() => {
    const validate = async () => {
      const result = await window.electron.recorder.validateOutputPath(outputDir);
      setIsValid(result.valid);
    };
    if (outputDir) validate();
  }, [outputDir]);

  // Fetch support ID on mount
  useEffect(() => {
    window.electron.telemetry.getSupportId().then(setSupportId).catch(console.error);
  }, []);

  const handleBrowse = async () => {
    const selectedPath = await window.electron.recorder.showOpenDialog();
    if (selectedPath) {
      onOutputDirChange(selectedPath);
    }
  };

  const handleCopySupportId = async () => {
    if (!supportId) return;
    await navigator.clipboard.writeText(supportId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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

        {/* Support ID */}
        {supportId && (
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
        )}
      </CardContent>
    </Card>
  );
}
