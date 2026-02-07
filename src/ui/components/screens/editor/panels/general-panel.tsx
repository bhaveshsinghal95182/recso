import { Input } from '@/components/ui/input';

import { useEditor } from '../../../../context/editor-context';
import BloomColorPicker from '../../../bloom-color-picker';

export function GeneralPanel() {
  const { project, updateBackgroundColor } = useEditor();

  if (!project) return null;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="bg-color" className="text-sm font-medium">
          Canvas Background
        </label>
        <div className="flex flex-col gap-4">
          <div className="flex justify-center py-4">
            <BloomColorPicker
              color={project.backgroundColor || '#000000'}
              onChange={updateBackgroundColor}
              stagger
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-12">Hex</span>
            <Input
              value={project.backgroundColor || '#000000'}
              onChange={(e) => updateBackgroundColor(e.target.value)}
              className="font-mono text-xs h-8"
              placeholder="#000000"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
