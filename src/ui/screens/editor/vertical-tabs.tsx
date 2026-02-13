import { Settings, ZoomIn } from 'lucide-react';
import { useMemo } from 'react';

import { type PropertiesTab, useEditor } from '@/context/editor-context';

function TabButton({
  label,
  Icon,
  active,
  onClick,
}: {
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-10 h-10 flex items-center justify-center rounded-md transition-colors ${
        active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/50'
      }`}
      title={label}
      aria-pressed={active}
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}

export function VerticalTabs() {
  const { activePropertiesTab, setActivePropertiesTab } = useEditor();

  const tabs: {
    id: PropertiesTab;
    label: string;
    Icon: React.ComponentType<{ className?: string }>;
  }[] = useMemo(
    () => [
      { id: 'general', label: 'General', Icon: Settings },
      { id: 'zoom', label: 'Zoom', Icon: ZoomIn },
    ],
    [],
  );

  return (
    <div className="absolute right-4 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-2 bg-card/80 backdrop-blur-sm p-1.5 rounded-lg border border-border">
      {tabs.map((t) => (
        <TabButton
          key={t.id}
          label={t.label}
          Icon={t.Icon}
          active={activePropertiesTab === t.id}
          onClick={() => setActivePropertiesTab(t.id)}
        />
      ))}
    </div>
  );
}
