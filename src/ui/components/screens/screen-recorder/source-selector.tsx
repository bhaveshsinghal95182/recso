import { AppWindow, Monitor, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
  if (isLoading) {
    return <div className="text-center p-4">Loading sources...</div>;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex justify-end p-2 border-b bg-muted/20">
        <Button variant="ghost" size="sm" onClick={onRefresh} className="gap-2">
          <RefreshCw size={14} />
          Refresh Sources
        </Button>
      </div>

      {sources.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-4 text-muted-foreground">
          No screens or windows found
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-4 overflow-y-auto">
          {sources.map((source) => (
            <div
              key={source.id}
              onClick={() => onSelect(source.id)}
              className={cn(
                'cursor-pointer rounded-lg border-2 transition-all hover:border-primary/50',
                selectedSourceId === source.id
                  ? 'border-primary bg-primary/5'
                  : 'border-transparent',
              )}
            >
              <Card className="border-0 shadow-none bg-transparent">
                <CardContent className="p-2 space-y-2">
                  <div className="aspect-video relative rounded-md overflow-hidden bg-black/10">
                    <img
                      src={source.thumbnailDataUrl}
                      alt={source.name}
                      className="w-full h-full object-contain"
                    />
                  </div>
                  <div className="flex items-center gap-2 text-sm font-medium leading-none">
                    {source.isScreen ? <Monitor size={14} /> : <AppWindow size={14} />}
                    <span className="truncate" title={source.name}>
                      {source.name}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
