import { Camera, MousePointer2, Settings, ZoomIn } from 'lucide-react';
import { useMemo } from 'react';

import { cn } from '@/lib/utils';
import { useUIStore } from '@/store/ui-store';
import type { PropertiesTab } from '@/types';

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
      type="button"
      onClick={onClick}
      className={cn(
        'grid size-[38px] cursor-pointer place-items-center rounded-[13px] border border-transparent text-white/50 transition duration-150',
        'hover:border-white/10 hover:bg-white/10 hover:text-white',
        active && 'border-[#5eead4]/35 bg-emerald-500/15 text-[#ccfbf1]',
      )}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      <Icon className="size-4" />
    </button>
  );
}

export function VerticalTabs() {
  const { activePropertiesTab, setActivePropertiesTab } = useUIStore();

  const tabs: {
    id: PropertiesTab;
    label: string;
    Icon: React.ComponentType<{ className?: string }>;
  }[] = useMemo(
    () => [
      { id: 'general', label: 'General', Icon: Settings },
      { id: 'webcam', label: 'Webcam', Icon: Camera },
      { id: 'cursor', label: 'Cursor', Icon: MousePointer2 },
      { id: 'zoom', label: 'Zoom', Icon: ZoomIn },
    ],
    [],
  );

  return (
    <div className="absolute right-4 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-1.5 rounded-[18px] border border-white/15 bg-[linear-gradient(180deg,rgba(255,255,255,0.1),transparent_58%),rgba(12,14,14,0.82)] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_24px_70px_rgba(0,0,0,0.52)] backdrop-blur-[24px]">
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
