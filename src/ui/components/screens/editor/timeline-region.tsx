/**
 * TimelineRegion Component
 *
 * A unified component for rendering timeline regions (cuts, zooms, etc.)
 * Supports:
 * - Dragging to move the region
 * - Resizing via edge handles
 * - Selection and deletion
 * - Customizable styling per region type
 */

import { useCallback, useRef, useState } from 'react';

export type RegionVariant = 'cut' | 'zoom';

export interface BaseRegion {
  id: string;
  startMs: number;
  endMs: number;
}

interface TimelineRegionProps<T extends BaseRegion> {
  /** The region data */
  region: T;
  /** Total video duration in milliseconds */
  duration: number;
  /** Whether this region is currently selected */
  isSelected: boolean;
  /** Visual variant for styling */
  variant: RegionVariant;
  /** Content to display inside the region */
  label?: string;
  /** Called when the region is clicked/selected */
  onSelect: () => void;
  /** Called when the region is moved or resized */
  onUpdate: (region: T) => void;
  /** Called when the region is deleted */
  onDelete: () => void;
}

// Variant-specific styling configuration
const variantStyles: Record<
  RegionVariant,
  {
    default: string;
    selected: string;
    deleteButton: string;
    deleteTitle: string;
  }
> = {
  cut: {
    default: 'bg-red-500/40 hover:bg-red-500/50',
    selected: 'bg-red-500/60 ring-2 ring-red-400',
    deleteButton: 'bg-red-600 hover:bg-red-700',
    deleteTitle: 'Remove cut',
  },
  zoom: {
    default: 'bg-cyan-500/40 hover:bg-cyan-500/50',
    selected: 'bg-cyan-500/60 ring-2 ring-cyan-400',
    deleteButton: 'bg-cyan-600 hover:bg-cyan-700',
    deleteTitle: 'Remove zoom',
  },
};

export function TimelineRegion<T extends BaseRegion>({
  region,
  duration,
  isSelected,
  variant,
  label,
  onSelect,
  onUpdate,
  onDelete,
}: TimelineRegionProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState<'left' | 'right' | null>(null);

  const styles = variantStyles[variant];

  // Convert time to percentage
  const timeToPercent = (time: number) => (duration > 0 ? (time / duration) * 100 : 0);

  const left = timeToPercent(region.startMs);
  const width = timeToPercent(region.endMs - region.startMs);

  // Handle drag to move
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelect();

      const parent = containerRef.current?.parentElement;
      if (!parent) return;

      const startX = e.clientX;
      const rect = parent.getBoundingClientRect();
      const originalStart = region.startMs;
      const regionDuration = region.endMs - region.startMs;

      setIsDragging(true);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const deltaPercent = deltaX / rect.width;
        const deltaMs = deltaPercent * duration;

        let newStart = Math.max(0, originalStart + deltaMs);
        let newEnd = newStart + regionDuration;

        // Clamp to duration
        if (newEnd > duration) {
          newEnd = duration;
          newStart = newEnd - regionDuration;
        }

        onUpdate({
          ...region,
          startMs: Math.round(newStart),
          endMs: Math.round(newEnd),
        });
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [region, duration, onSelect, onUpdate],
  );

  // Handle resize from edges
  const handleResizeStart = useCallback(
    (e: React.MouseEvent, edge: 'left' | 'right') => {
      e.stopPropagation();
      onSelect();

      const parent = containerRef.current?.parentElement;
      if (!parent) return;

      const startX = e.clientX;
      const rect = parent.getBoundingClientRect();
      const originalStartMs = region.startMs;
      const originalEndMs = region.endMs;

      setIsResizing(edge);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const deltaPercent = deltaX / rect.width;
        const deltaMs = deltaPercent * duration;

        if (edge === 'left') {
          const newStart = Math.max(0, Math.min(originalEndMs - 100, originalStartMs + deltaMs));
          onUpdate({
            ...region,
            startMs: Math.round(newStart),
            endMs: originalEndMs,
          });
        } else {
          const newEnd = Math.min(
            duration,
            Math.max(originalStartMs + 100, originalEndMs + deltaMs),
          );
          onUpdate({
            ...region,
            startMs: originalStartMs,
            endMs: Math.round(newEnd),
          });
        }
      };

      const handleMouseUp = () => {
        setIsResizing(null);
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [region, duration, onSelect, onUpdate],
  );

  // Handle keyboard delete
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        onDelete();
      }
    },
    [onDelete],
  );

  // Handle delete button click
  const handleDeleteClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete();
    },
    [onDelete],
  );

  return (
    <div
      ref={containerRef}
      className={`absolute top-1 bottom-1 rounded cursor-move transition-colors group ${
        isSelected ? styles.selected : styles.default
      } ${isDragging || isResizing ? 'cursor-grabbing' : ''}`}
      style={{
        left: `${left}%`,
        width: `${Math.max(width, 0.5)}%`,
      }}
      onMouseDown={handleMouseDown}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
      tabIndex={isSelected ? 0 : -1}
    >
      {/* Left resize handle - visible bar */}
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize flex items-center justify-center hover:bg-white/20"
        onMouseDown={(e) => handleResizeStart(e, 'left')}
      >
        <div className="w-0.5 h-4 bg-white/60 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>

      {/* Right resize handle - visible bar */}
      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize flex items-center justify-center hover:bg-white/20"
        onMouseDown={(e) => handleResizeStart(e, 'right')}
      >
        <div className="w-0.5 h-4 bg-white/60 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>

      {/* Delete button */}
      <button
        type="button"
        className={`absolute -top-2 -right-2 w-4 h-4 ${styles.deleteButton} rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-20`}
        onClick={handleDeleteClick}
        title={styles.deleteTitle}
      >
        <svg
          className="w-2.5 h-2.5 text-white"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        >
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>

      {/* Region label */}
      {label && width > 5 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-[10px] text-white/70 font-medium select-none">{label}</span>
        </div>
      )}
    </div>
  );
}
