import type { ReactNode } from 'react';

import { WindowTitlebar } from '@/components/common/window-titlebar';
import { TooltipProvider } from '@/components/ui/tooltip';

interface RootLayoutProps {
  children: ReactNode;
  className?: string; // Allow additional styling for specific layouts
}

export function RootLayout({ children, className = '' }: RootLayoutProps) {
  return (
    <div
      className={`h-screen flex flex-col bg-background text-foreground overflow-hidden ${className}`}
    >
      <TooltipProvider>
        <WindowTitlebar />
        <div className="flex-1 min-h-0 relative flex flex-col">{children}</div>
      </TooltipProvider>
    </div>
  );
}
