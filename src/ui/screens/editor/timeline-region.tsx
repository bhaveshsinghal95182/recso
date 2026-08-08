/**
 * TimelineRegion Component
 *
 * A unified component for rendering timeline regions (cuts, zooms, cursor spans).
 * Supports:
 * - Dragging to move the region
 * - Resizing via edge handles
 * - Selection and deletion
 *
 * Every region renders at the same height inside its lane and shares one neutral
 * surface; type is communicated by the icon and lane, not by a saturated fill.
 */

import { MousePointer2, Scissors, X, ZoomIn } from 'lucide-react';
import type { ComponentType } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { usePlaybackStore } from '@/store/playback-store';

export type RegionVariant = 'cut' | 'zoom' | 'cursor';

export interface BaseRegion {
  id: string;
  startMs: number;
  endMs: number;
}

export interface RegionDeleteIntent {
  deleteAllLinked?: boolean;
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
  onDelete: (intent?: RegionDeleteIntent) => void;
  /** Whether this region can be moved/resized/deleted */
  editable?: boolean;
  /** Optional cut identifier used for marquee multi-select queries */
  dataCutId?: string;
  /** Optional region identifier used for marquee multi-select queries */
  dataRegionId?: string;
  /** Optional region type used for marquee multi-select queries */
  dataRegionType?: RegionVariant;
}

const variantMeta: Record<
  RegionVariant,
  { icon: ComponentType<{ className?: string; size?: number }>; deleteTitle: string; layer: number }
> = {
  cut: { icon: Scissors, deleteTitle: 'Remove cut', layer: 12 },
  zoom: { icon: ZoomIn, deleteTitle: 'Remove zoom', layer: 9 },
  cursor: { icon: MousePointer2, deleteTitle: 'Remove cursor region', layer: 6 },
};

/**
 * Type identity is carried by a hairline edge and the icon only — never by the
 * body fill. Emerald stays reserved for selection, so it is absent here.
 */
export const regionAccentText: Record<RegionVariant, string> = {
  cut: 'text-rose-300/75',
  zoom: 'text-sky-300/75',
  cursor: 'text-amber-300/70',
};

const regionAccentBar: Record<RegionVariant, string> = {
  cut: 'bg-rose-300/55',
  zoom: 'bg-sky-300/55',
  cursor: 'bg-amber-300/45',
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
  editable = true,
  dataCutId,
  dataRegionId,
  dataRegionType,
}: TimelineRegionProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [localRegion, setLocalRegion] = useState<T>(region);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState<'left' | 'right' | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isPlaying, pause } = usePlaybackStore();

  // Sync with prop when not interacting
  useEffect(() => {
    if (!isDragging && !isResizing) {
      setLocalRegion(region);
    }
  }, [region, isDragging, isResizing]);

  // Clean up debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const meta = variantMeta[variant];
  const Icon = meta.icon;

  // Convert time to percentage
  const timeToPercent = (time: number) => (duration > 0 ? (time / duration) * 100 : 0);

  const left = timeToPercent(localRegion.startMs);
  const width = timeToPercent(localRegion.endMs - localRegion.startMs);

  const debouncedUpdate = useCallback(
    (newRegion: T) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onUpdate(newRegion);
      }, 100);
    },
    [onUpdate],
  );

  // Handle drag to move
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!editable) {
        return;
      }

      e.stopPropagation();
      onSelect();

      const parent = containerRef.current?.parentElement;
      if (!parent) return;

      if (isPlaying) {
        pause();
      }

      const startX = e.clientX;
      const rect = parent.getBoundingClientRect();
      const originalStart = localRegion.startMs;
      const regionDuration = localRegion.endMs - localRegion.startMs;

      setIsDragging(true);

      let currentRegion = localRegion;

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

        const updated = {
          ...currentRegion,
          startMs: Math.round(newStart),
          endMs: Math.round(newEnd),
        };
        currentRegion = updated;
        setLocalRegion(updated);
        debouncedUpdate(updated);
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        onUpdate(currentRegion);
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [localRegion, duration, onSelect, onUpdate, debouncedUpdate, editable, isPlaying, pause],
  );

  // Handle resize from edges
  const handleResizeStart = useCallback(
    (e: React.MouseEvent, edge: 'left' | 'right') => {
      if (!editable) {
        return;
      }

      e.stopPropagation();
      onSelect();

      const parent = containerRef.current?.parentElement;
      if (!parent) return;

      const startX = e.clientX;
      const rect = parent.getBoundingClientRect();
      const originalStartMs = localRegion.startMs;
      const originalEndMs = localRegion.endMs;

      setIsResizing(edge);

      let currentRegion = localRegion;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const deltaPercent = deltaX / rect.width;
        const deltaMs = deltaPercent * duration;

        let updated: T;
        if (edge === 'left') {
          const newStart = Math.max(0, Math.min(originalEndMs - 100, originalStartMs + deltaMs));
          updated = {
            ...currentRegion,
            startMs: Math.round(newStart),
            endMs: originalEndMs,
          };
        } else {
          const newEnd = Math.min(
            duration,
            Math.max(originalStartMs + 100, originalEndMs + deltaMs),
          );
          updated = {
            ...currentRegion,
            startMs: originalStartMs,
            endMs: Math.round(newEnd),
          };
        }

        currentRegion = updated;
        setLocalRegion(updated);
        debouncedUpdate(updated);
      };

      const handleMouseUp = () => {
        setIsResizing(null);
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        onUpdate(currentRegion);
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [localRegion, duration, onSelect, onUpdate, debouncedUpdate, editable],
  );

  // Handle keyboard delete
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!editable) {
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        onDelete({
          deleteAllLinked: e.ctrlKey || e.metaKey,
        });
      }
    },
    [editable, onDelete],
  );

  // Handle delete button click
  const handleDeleteClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete({
        deleteAllLinked: e.ctrlKey || e.metaKey,
      });
    },
    [onDelete],
  );

  return (
    <div
      ref={containerRef}
      className={cn(
        '@container group absolute top-[5px] bottom-[5px] flex items-center gap-1.5 overflow-hidden rounded-[8px] border pl-2 pr-1.5',
        'border-white/12 bg-white/[0.07] text-white/60 transition duration-150',
        'hover:border-white/25 hover:bg-white/[0.13] hover:text-white/90',
        isSelected &&
          'border-[#5eead4]/45 bg-emerald-400/15 text-[#ccfbf1] hover:border-[#5eead4]/55 hover:bg-emerald-400/20',
        editable
          ? isDragging || isResizing
            ? 'cursor-grabbing'
            : 'cursor-move'
          : 'cursor-pointer',
      )}
      style={{
        left: `${left}%`,
        width: `${Math.max(width, 0.25)}%`,
        minWidth: 8,
        zIndex: meta.layer,
      }}
      data-cut-id={dataCutId}
      data-region-id={dataRegionId}
      data-region-type={dataRegionType}
      onMouseDown={editable ? handleMouseDown : undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (!editable) {
          onSelect();
        }
      }}
      onKeyDown={handleKeyDown}
      tabIndex={isSelected && editable ? 0 : -1}
    >
      {/* Hairline type accent — the only colour on the region body */}
      <span
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 w-[2px]',
          isSelected ? 'bg-[#5eead4]/70' : regionAccentBar[variant],
        )}
      />

      {editable && (
        <>
          {/* Edge resize handles */}
          <div
            className="absolute left-0 top-0 bottom-0 z-10 flex w-1.5 cursor-ew-resize items-center justify-center"
            onMouseDown={(e) => handleResizeStart(e, 'left')}
          >
            <div className="h-3.5 w-0.5 rounded-full bg-current opacity-0 transition-opacity group-hover:opacity-60" />
          </div>

          <div
            className="absolute right-0 top-0 bottom-0 z-10 flex w-1.5 cursor-ew-resize items-center justify-center"
            onMouseDown={(e) => handleResizeStart(e, 'right')}
          >
            <div className="h-3.5 w-0.5 rounded-full bg-current opacity-0 transition-opacity group-hover:opacity-60" />
          </div>
        </>
      )}

      {/* Identity: icon shows up once the region is wide enough to hold it */}
      <Icon
        className={cn('hidden shrink-0 @[26px]:block', !isSelected && regionAccentText[variant])}
        size={11}
      />

      {label && (
        <span className="hidden truncate text-[10px] font-[700] tracking-[0.06em] select-none @[74px]:inline">
          {label}
        </span>
      )}

      {editable && (
        <button
          type="button"
          className="ml-auto hidden size-4 shrink-0 place-items-center rounded-full bg-white/10 text-white/70 opacity-0 transition hover:bg-red-500/70 hover:text-white group-hover:opacity-100 @[74px]:grid"
          onClick={handleDeleteClick}
          title={`${meta.deleteTitle} (Ctrl+click removes it from every lane)`}
        >
          <X size={9} strokeWidth={3} />
        </button>
      )}
    </div>
  );
}
