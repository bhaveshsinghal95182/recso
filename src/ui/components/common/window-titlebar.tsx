import { Copy, Settings, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { SettingsDialog } from '@/components/settings-dialog';
import { Button } from '@/components/ui/button';

import Minimize24Regular from '../icons/minimize';

export const WindowTitlebar = () => {
  const [isMaximized, setIsMaximized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // const [supportId, setSupportId] = useState<string>('');
  // const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Get initial state
    window.electron.window.isMaximized().then(setIsMaximized);

    // Fetch Support ID
    // window.electron.telemetry.getSupportId().then(setSupportId).catch(console.error);

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

  // const handleCopySupportId = async () => {
  //   if (!supportId) return;
  //   await navigator.clipboard.writeText(supportId);
  //   setCopied(true);
  //   setTimeout(() => setCopied(false), 2000);
  // };

  return (
    <nav className="flex items-center justify-between  bg-linear-to-b from-gray-900/90 to-gray-800/90 backdrop-blur-md border-b border-white/10 shadow-lg select-none z-50 app-region-drag">
      <div className="flex items-center gap-2 px-4 py-2">
        <h1 className="text-md font-semibold tracking-wide text-white/70 font-inter">Recso</h1>
      </div>
      <div className="flex h-full items-center [-webkit-app-region:no-drag]">
        <Button
          variant="ghost"
          size="icon-lg"
          className="cursor-pointer text-gray-400 hover:text-white hover:bg-white/10 group h-full w-12"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
        >
          <Settings size="15" className="transform group-hover:scale-105 transition-transform" />
        </Button>
        <Button
          variant="ghost"
          size="icon-lg"
          className="cursor-pointer text-gray-400 hover:text-white hover:bg-white/10 group h-full w-12"
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
          size="icon-lg"
          className="cursor-pointer text-gray-400 hover:text-white hover:bg-white/10 group h-full w-12"
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
          size="icon-lg"
          className="cursor-pointer text-gray-400 hover:text-red-500 hover:bg-red-500/80 group h-full w-12"
          onClick={handleClose}
          title="Close"
        >
          <X size="14" className="transform group-hover:scale-105 transition-transform" />
        </Button>
      </div>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </nav>
  );
};
