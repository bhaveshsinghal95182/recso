import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

import { useEditor } from '../../../../context/editor-context';

export function GeneralPanel() {
  const { project, updateBackgroundColor } = useEditor();

  if (!project) return null;

  const isBackgroundEnabled = project.backgroundColor !== 'transparent';

  const handleBackgroundToggle = (checked: boolean) => {
    if (checked) {
      updateBackgroundColor('#000000');
    } else {
      updateBackgroundColor('transparent');
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <label htmlFor="bg-color" className="text-sm font-medium">
            Canvas Background
          </label>
          <Switch checked={isBackgroundEnabled} onCheckedChange={handleBackgroundToggle} />
        </div>
        {isBackgroundEnabled && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-12">Hex</span>
            <Input
              value={project.backgroundColor || '#000000'}
              onChange={(e) => updateBackgroundColor(e.target.value)}
              className="font-mono text-xs h-8"
              placeholder="#000000"
            />
            <Input
              type="color"
              value={project.backgroundColor || '#000000'}
              onChange={(e) => updateBackgroundColor(e.target.value)}
              className="h-8 w-14"
            />
          </div>
        )}
      </div>
    </div>
  );
}
