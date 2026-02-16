import { ChevronDown, ChevronUp } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

interface PaginatedGridProps<T> {
  items: T[];
  renderItem: (item: T) => React.ReactNode;
  itemsPerPage?: number;
  className?: string;
  gridClassName?: string;
  keyExtractor?: (item: T) => string;
  disableAnimation?: boolean;
}

export function PaginatedGrid<T>({
  items,
  renderItem,
  itemsPerPage = 8,
  className = '',
  gridClassName = 'grid-cols-4',
  keyExtractor,
  disableAnimation = false,
}: PaginatedGridProps<T>) {
  const [isExpanded, setIsExpanded] = useState(false);

  // If not expanded, show only the first page
  const visibleItems = isExpanded ? items : items.slice(0, itemsPerPage);
  const hasMore = items.length > itemsPerPage;

  return (
    <div className={`space-y-2 ${className}`}>
      <motion.div layout className={`grid gap-2 w-full ${gridClassName}`}>
        <AnimatePresence>
          {visibleItems.map((item, index) => {
            const key = keyExtractor ? keyExtractor(item) : (item as any).id || String(index);

            if (disableAnimation) {
              return <div key={key}>{renderItem(item)}</div>;
            }

            return (
              <motion.div
                key={key}
                layout
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
              >
                {renderItem(item)}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </motion.div>

      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {isExpanded ? (
              <>
                Show Less <ChevronUp className="size-3" />
              </>
            ) : (
              <>
                Show More <ChevronDown className="size-3" />
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
