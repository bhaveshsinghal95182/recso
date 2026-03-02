import { Check, Copy, Headset, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import Minimize24Regular from '../icons/minimize';

export const WindowTitlebar = () => {
  const [isMaximized, setIsMaximized] = useState(false);
  const [supportId, setSupportId] = useState<string>('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Get initial state
    window.electron.window.isMaximized().then(setIsMaximized);

    // Fetch Support ID
    window.electron.telemetry.getSupportId().then(setSupportId).catch(console.error);

    // Subscribe to changes
    const unsubscribe = window.electron.window.onMaximizeChange(setIsMaximized);
    return unsubscribe;
  }, []);

  const handleClose = () => {
    window.electron.window.close();
  };

  const handleHideToTray = () => {
    window.electron.window.hideToTray();
  };

  const handleMaximizeToggle = () => {
    window.electron.window.maximize();
  };

  const handleCopySupportId = async () => {
    if (!supportId) return;
    await navigator.clipboard.writeText(supportId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <nav className="flex items-center justify-between px-4 py-2 bg-linear-to-b from-gray-900/90 to-gray-800/90 backdrop-blur-md border-b border-white/10 shadow-lg select-none z-50 app-region-drag">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-red-500/80 shadow-[0_0_8px_rgba(239,68,68,0.6)]"></div>
        <h1 className="text-sm font-semibold tracking-wide text-white/90 font-inter">Recso</h1>
      </div>
      <div className="nav-buttons flex items-center gap-1.5 app-region-no-drag">
        {/* Support ID Button */}
        {supportId && (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="cursor-pointer text-gray-400 hover:text-white hover:bg-white/10 group h-6 w-6 mr-2"
                onClick={handleCopySupportId}
              >
                {copied ? (
                  <Check size="14" className="text-green-500" />
                ) : (
                  <Headset
                    size="14"
                    className="transform group-hover:scale-105 transition-transform"
                  />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs font-mono">
              {copied ? 'Copied!' : `Support ID: ${supportId} (Click to copy)`}
            </TooltipContent>
          </Tooltip>
        )}

        <Button
          variant="ghost"
          size="icon-sm"
          className="tray-btn cursor-pointer text-gray-400 hover:text-white hover:bg-white/10 group h-6 w-6"
          onClick={handleHideToTray}
          title="Hide to Tray"
        >
          <Minimize24Regular
            size="16"
            className="transform group-hover:scale-105 transition-transform"
          />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="max-btn cursor-pointer text-gray-400 hover:text-white hover:bg-white/10 group h-6 w-6"
          onClick={handleMaximizeToggle}
          title={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? (
            <Copy size="14" className="transform group-hover:scale-105 transition-transform" />
          ) : (
            <Square size="14" className="transform group-hover:scale-105 transition-transform" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="close-btn cursor-pointer text-gray-400 hover:text-white hover:bg-red-500/80 group h-6 w-6"
          onClick={handleClose}
          title="Close"
        >
          <X size="14" className="transform group-hover:scale-105 transition-transform" />
        </Button>
      </div>
    </nav>
  );
};
