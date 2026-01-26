import { AppWindow, Monitor } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { DesktopSource } from '@/types';

interface SourceSelectorProps {
  sources: DesktopSource[];
  selectedSourceId: string | null;
  onSelect: (id: string) => void;
  isLoading?: boolean;
}

export function SourceSelector({
  sources,
  selectedSourceId,
  onSelect,
  isLoading,
}: SourceSelectorProps) {
  if (isLoading) {
    return <div className="text-center p-4">Loading sources...</div>;
  }

  if (sources.length === 0) {
    return <div className="text-center p-4 text-muted-foreground">No screens or windows found</div>;
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-4 max-h-[400px] overflow-y-auto">
      {sources.map((source) => (
        <div
          key={source.id}
          onClick={() => onSelect(source.id)}
          className={cn(
            'cursor-pointer rounded-lg border-2 transition-all hover:border-primary/50',
            selectedSourceId === source.id ? 'border-primary bg-primary/5' : 'border-transparent',
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
  );
}
