import { Monitor, RefreshCw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

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
  return (
    <div className="flex flex-col h-full bg-background/50 backdrop-blur-sm relative overflow-hidden">
      {/* Dynamic Background Gradients */}
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none opacity-20">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-purple-500/30 rounded-full blur-[100px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-500/30 rounded-full blur-[100px]" />
      </div>

      <div className="flex items-center justify-between p-4 z-10 border-b border-border/40 bg-background/20 backdrop-blur-md">
        <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
          <Monitor size={16} className="text-primary" />
          Available Monitors
        </h3>

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
          <TooltipContent side="left">Refresh monitors</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex-1 overflow-y-auto p-4 z-10 custom-scrollbar">
        {isLoading ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-3">
            <RefreshCw className="animate-spin text-primary" size={32} />
            <p>Detecting monitors...</p>
          </div>
        ) : sources.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-4">
            <div className="p-4 rounded-full bg-muted/20">
              <Monitor size={48} className="opacity-50" />
            </div>
            <div className="text-center">
              <h3 className="text-lg font-medium text-foreground">No monitors found</h3>
              <p className="text-sm opacity-70 mt-1">Try refreshing</p>
            </div>
            <Button variant="outline" onClick={onRefresh}>
              Refresh Now
            </Button>
          </div>
        ) : (
          <motion.div layout className="flex flex-col gap-3">
            <AnimatePresence mode="popLayout">
              {sources.map((source) => (
                <MonitorCard
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

function MonitorCard({
  source,
  isSelected,
  onSelect,
}: {
  source: DesktopSource;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const resolution = source.width && source.height ? `${source.width}×${source.height}` : null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      whileHover={{ scale: 1.01 }}
      transition={{ type: 'spring', bounce: 0.3, duration: 0.3 }}
      onClick={() => onSelect(source.id)}
      className="group cursor-pointer"
    >
      <div
        className={cn(
          'relative flex items-center gap-4 p-4 rounded-xl border-2 transition-all duration-200',
          isSelected
            ? 'border-primary bg-primary/5 shadow-[0_0_20px_-5px_hsl(var(--primary))]'
            : 'border-transparent bg-card/50 hover:border-white/20 hover:bg-card/80',
        )}
      >
        {/* Monitor Icon */}
        <div
          className={cn(
            'p-3 rounded-lg transition-colors',
            isSelected ? 'bg-primary/20 text-primary' : 'bg-muted/50 text-muted-foreground',
          )}
        >
          <Monitor size={24} />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground truncate">{source.name}</span>
            {source.isPrimary && (
              <span className="px-2 py-0.5 text-[10px] font-semibold uppercase bg-primary/20 text-primary rounded-full">
                Primary
              </span>
            )}
          </div>
          {resolution && <span className="text-sm text-muted-foreground">{resolution}</span>}
        </div>

        {/* Selection Indicator */}
        {isSelected && <div className="w-3 h-3 rounded-full bg-primary animate-pulse" />}
      </div>
    </motion.div>
  );
}
