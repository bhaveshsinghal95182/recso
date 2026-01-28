import { AppWindow, Layers, Monitor, MonitorPlay, RefreshCw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { DesktopSource } from '@/types';

interface SourceSelectorProps {
  sources: DesktopSource[];
  selectedSourceId: string | null;
  onSelect: (id: string) => void;
  isLoading?: boolean;
  onRefresh?: () => void;
}

export function SourceSelector({
  sources,
  selectedSourceId,
  onSelect,
  isLoading,
  onRefresh,
}: SourceSelectorProps) {
  const [activeTab, setActiveTab] = useState<'all' | 'screen' | 'window'>('all');

  const filteredSources = sources.filter((source) => {
    if (activeTab === 'all') return true;
    if (activeTab === 'screen') return source.isScreen;
    if (activeTab === 'window') return !source.isScreen;
    return true;
  });

  const screensCount = sources.filter((s) => s.isScreen).length;
  const windowsCount = sources.filter((s) => !s.isScreen).length;

  return (
    <div className="flex flex-col h-full bg-background/50 backdrop-blur-sm relative overflow-hidden">
      {/* Dynamic Background Gradients */}
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none opacity-20">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-purple-500/30 rounded-full blur-[100px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-500/30 rounded-full blur-[100px]" />
      </div>

      <div className="flex items-center justify-between p-4 z-10 border-b border-border/40 bg-background/20 backdrop-blur-md">
        <div className="flex items-center gap-1 bg-muted/30 p-1 rounded-lg border border-border/20">
          <TabButton
            active={activeTab === 'all'}
            onClick={() => setActiveTab('all')}
            icon={<Layers size={14} />}
            label="All"
            count={sources.length}
          />
          <TabButton
            active={activeTab === 'screen'}
            onClick={() => setActiveTab('screen')}
            icon={<Monitor size={14} />}
            label="Screens"
            count={screensCount}
          />
          <TabButton
            active={activeTab === 'window'}
            onClick={() => setActiveTab('window')}
            icon={<AppWindow size={14} />}
            label="Windows"
            count={windowsCount}
          />
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onRefresh}
              className="relative hover:bg-primary/20 hover:text-primary transition-colors"
              disabled={isLoading}
            >
              <RefreshCw size={16} className={cn(isLoading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Refresh available sources</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex-1 overflow-y-auto p-4 z-10 custom-scrollbar">
        {isLoading ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-3">
            <RefreshCw className="animate-spin text-primary" size={32} />
            <p>Scanning sources...</p>
          </div>
        ) : sources.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-4">
            <div className="p-4 rounded-full bg-muted/20">
              <MonitorPlay size={48} className="opacity-50" />
            </div>
            <div className="text-center">
              <h3 className="text-lg font-medium text-foreground">No sources found</h3>
              <p className="text-sm opacity-70 mt-1">Check your permissions or try refreshing</p>
            </div>
            <Button variant="outline" onClick={onRefresh}>
              Refresh Now
            </Button>
          </div>
        ) : (
          <motion.div layout className="grid grid-cols-2 md:grid-cols-3 gap-6">
            <AnimatePresence mode="popLayout">
              {filteredSources.map((source) => (
                <SourceCard
                  key={source.id}
                  source={source}
                  isSelected={selectedSourceId === source.id}
                  onSelect={onSelect}
                />
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-2',
        active
          ? 'text-primary-foreground'
          : 'text-muted-foreground hover:bg-white/5 hover:text-foreground',
      )}
    >
      {active && (
        <motion.div
          layoutId="activeTab"
          className="absolute inset-0 bg-primary rounded-md shadow-sm"
          transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
        />
      )}
      <span className="relative z-10 flex items-center gap-1.5">
        {icon}
        {label}
        <span
          className={cn(
            'ml-1 px-1 rounded-full text-[10px]',
            active
              ? 'bg-primary-foreground/20 text-primary-foreground'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {count}
        </span>
      </span>
    </button>
  );
}

function SourceCard({
  source,
  isSelected,
  onSelect,
}: {
  source: DesktopSource;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      whileHover={{ y: -4, scale: 1.02 }}
      transition={{ type: 'spring', bounce: 0.4, duration: 0.4 }}
      onClick={() => onSelect(source.id)}
      className="group cursor-pointer"
    >
      <div
        className={cn(
          'relative overflow-hidden rounded-xl border-2 transition-all duration-300',
          isSelected
            ? 'border-primary shadow-[0_0_20px_-5px_hsl(var(--primary))]'
            : 'border-transparent hover:border-white/20 hover:bg-white/5',
        )}
      >
        <div
          className={cn(
            'aspect-video relative overflow-hidden bg-gradient-to-br from-gray-900 to-black',
            isSelected ? 'opacity-100' : 'opacity-80 group-hover:opacity-100',
          )}
        >
          {source.thumbnailDataUrl ? (
            <img
              src={source.thumbnailDataUrl}
              alt={source.name}
              className="w-full h-full object-contain p-2"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground/30">
              {source.isScreen ? <Monitor size={48} /> : <AppWindow size={48} />}
            </div>
          )}

          {/* Selection Overlay */}
          {isSelected && (
            <div className="absolute inset-0 bg-primary/10 flex items-center justify-center backdrop-blur-[1px]">
              <div className="bg-primary text-primary-foreground rounded-full p-2 shadow-lg scale-0 animate-in zoom-in duration-200 fill-mode-forwards">
                <MonitorPlay size={24} fill="currentColor" />
              </div>
            </div>
          )}
        </div>

        <div
          className={cn(
            'p-3 border-t backdrop-blur-md transition-colors',
            isSelected
              ? 'bg-primary/10 border-primary/20'
              : 'bg-background/40 border-white/5 group-hover:bg-background/60',
          )}
        >
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'p-1.5 rounded-md',
                isSelected ? 'bg-primary/20 text-primary' : 'bg-muted/50 text-muted-foreground',
              )}
            >
              {source.isScreen ? <Monitor size={14} /> : <AppWindow size={14} />}
            </div>
            <span className="text-xs font-medium truncate flex-1 opacity-90" title={source.name}>
              {source.name}
            </span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
