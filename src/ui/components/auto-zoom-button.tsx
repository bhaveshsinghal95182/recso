import { Zap } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Project } from '@/types';

import { Button } from './ui/button';

export function AutoZoomButton({
  generateZoomsFromClicks,
  isGenerating,
  project,
}: {
  generateZoomsFromClicks: () => void;
  isGenerating: boolean;
  project: Project | null;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={'outline'}
          onClick={generateZoomsFromClicks}
          disabled={isGenerating || !project}
          className="w-full flex items-center justify-center"
        >
          <Zap />
          {isGenerating ? 'Generating...' : 'Auto Zooms'}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={'bottom'}>Creates zoom regions for each mouse click</TooltipContent>
    </Tooltip>
  );
}
