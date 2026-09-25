import { ImagePlus, MousePointer2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { cn } from '@/lib/utils';
import {
  type CursorTimelineRegion,
  deriveCursorTimelineRegions,
  resolveCursorRegionKey,
} from '@/screens/editor/cursor-timeline-regions';
import { useProjectStore } from '@/store/project-store';
import { focusedCursorRegionId, useTimelineStore } from '@/store/timeline-store';
import type { CursorRegionOverride } from '@/types';

import {
  PANEL_LABEL,
  PanelButton,
  PanelEmpty,
  PanelNote,
  PanelSection,
  PanelSlider,
} from './panel-kit';

interface CursorTypeGroup {
  key: string;
  label: string;
  regions: CursorTimelineRegion[];
  sourceCursorDataUrl?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getCursorTypeLabel(key: string, dataCursorOrdinal: number): string {
  if (key === 'default') {
    return 'Default Cursor';
  }

  if (key.startsWith('handle:')) {
    return `Handle ${key.slice('handle:'.length)}`;
  }

  if (key.startsWith('data:')) {
    return `Captured Cursor ${dataCursorOrdinal}`;
  }

  return key;
}

function formatMilliseconds(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  const totalSeconds = Math.floor(clamped / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = clamped % 1000;

  return `${minutes}:${seconds.toString().padStart(2, '0')}.${Math.floor(millis / 100)}`;
}

function toImageSrc(path: string | undefined): string | null {
  if (!path) {
    return null;
  }

  if (path.startsWith('data:') || path.startsWith('file:') || path.startsWith('http')) {
    return path;
  }

  const normalized = path.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }

  if (normalized.startsWith('/')) {
    return `file://${encodeURI(normalized)}`;
  }

  return normalized;
}

export function CursorPanel() {
  const {
    project,
    mouseEvents,
    updateCursorConfig,
    upsertCursorRegionOverride,
    replaceCursorRegionOverrides,
    removeCursorRegionOverride,
  } = useProjectStore();
  const selectedCursorRegionId = focusedCursorRegionId(useTimelineStore((s) => s.focus));
  const [packAssignments, setPackAssignments] = useState<Record<string, string>>({});
  const [isApplyingPack, setIsApplyingPack] = useState(false);

  if (!project) {
    return null;
  }

  const cursor = project.cursorConfig;
  const cursorRegions = useMemo(
    () => deriveCursorTimelineRegions(mouseEvents, project.timeline.duration),
    [mouseEvents, project.timeline.duration],
  );
  const sourceCursorByKey = useMemo(() => {
    const next = new Map<string, string>();

    for (const event of mouseEvents) {
      if (!event.cursorDataUrl) {
        continue;
      }

      const key = resolveCursorRegionKey(event);
      if (!next.has(key)) {
        next.set(key, event.cursorDataUrl);
      }
    }

    return next;
  }, [mouseEvents]);
  const cursorTypeGroups = useMemo<CursorTypeGroup[]>(() => {
    const groups = new Map<string, CursorTypeGroup>();
    let dataCursorOrdinal = 0;

    for (const region of cursorRegions) {
      const existing = groups.get(region.key);
      if (existing) {
        existing.regions.push(region);
        continue;
      }

      if (region.key.startsWith('data:')) {
        dataCursorOrdinal += 1;
      }

      groups.set(region.key, {
        key: region.key,
        label: getCursorTypeLabel(region.key, dataCursorOrdinal),
        regions: [region],
        sourceCursorDataUrl: sourceCursorByKey.get(region.key),
      });
    }

    return [...groups.values()];
  }, [cursorRegions, sourceCursorByKey]);
  const cursorRegionKeyById = useMemo(
    () => new Map(cursorRegions.map((region) => [region.id, region.key])),
    [cursorRegions],
  );

  useEffect(() => {
    setPackAssignments((current) => {
      const validKeys = new Set(cursorTypeGroups.map((group) => group.key));
      const next: Record<string, string> = {};

      for (const [key, value] of Object.entries(current)) {
        if (validKeys.has(key)) {
          next[key] = value;
        }
      }

      return next;
    });
  }, [cursorTypeGroups]);
  const selectedCursorRegion = useMemo(() => {
    if (!selectedCursorRegionId) {
      return null;
    }

    return cursorRegions.find((region) => region.id === selectedCursorRegionId) ?? null;
  }, [cursorRegions, selectedCursorRegionId]);
  const selectedRegionOverride = useMemo(() => {
    if (!selectedCursorRegion) {
      return null;
    }

    return (
      project.cursorRegionOverrides?.find(
        (cursorOverride) => cursorOverride.regionId === selectedCursorRegion.id,
      ) ?? null
    );
  }, [project.cursorRegionOverrides, selectedCursorRegion]);
  const isEditingRegionOverride = Boolean(selectedCursorRegion);
  const activeImage = toImageSrc(
    isEditingRegionOverride ? selectedRegionOverride?.imagePath : cursor.customImagePath,
  );
  const hasPackImage = cursorTypeGroups.some(
    (group) => typeof packAssignments[group.key] === 'string' && packAssignments[group.key].trim(),
  );
  const hasExistingOverrides = (project.cursorRegionOverrides ?? []).length > 0;

  const applyCursorImage = async (imagePath: string) => {
    if (selectedCursorRegion) {
      await upsertCursorRegionOverride({
        regionId: selectedCursorRegion.id,
        startMs: selectedCursorRegion.startMs,
        endMs: selectedCursorRegion.endMs,
        imagePath,
      });
      return;
    }

    await updateCursorConfig({ style: 'custom', customImagePath: imagePath });
  };

  const handleSizeInput = (nextValue: number) => {
    if (!Number.isFinite(nextValue)) {
      return;
    }

    void updateCursorConfig({ size: clamp(nextValue, 0.2, 3) });
  };

  const openCursorPicker = async () => {
    const selectedPath = await window.electron.editor.showCursorPicker();
    if (!selectedPath) {
      return;
    }

    await applyCursorImage(selectedPath);
  };

  const assignPackImage = async (key: string) => {
    const selectedPath = await window.electron.editor.showCursorPicker();
    if (!selectedPath) {
      return;
    }

    setPackAssignments((current) => ({
      ...current,
      [key]: selectedPath,
    }));
  };

  const clearPackImage = (key: string) => {
    setPackAssignments((current) => {
      if (!(key in current)) {
        return current;
      }

      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const loadPackFromExistingOverrides = () => {
    const next: Record<string, string> = {};
    for (const cursorOverride of project.cursorRegionOverrides ?? []) {
      const regionKey = cursorRegionKeyById.get(cursorOverride.regionId);
      if (!regionKey || next[regionKey]) {
        continue;
      }

      next[regionKey] = cursorOverride.imagePath;
    }

    setPackAssignments(next);
  };

  const applyPackToTimeline = async () => {
    if (isApplyingPack) {
      return;
    }

    setIsApplyingPack(true);
    try {
      const nextOverrides: CursorRegionOverride[] = [];
      for (const region of cursorRegions) {
        const imagePath = packAssignments[region.key]?.trim();
        if (!imagePath) {
          continue;
        }

        nextOverrides.push({
          regionId: region.id,
          startMs: region.startMs,
          endMs: region.endMs,
          imagePath,
        });
      }

      await replaceCursorRegionOverrides(nextOverrides);
    } finally {
      setIsApplyingPack(false);
    }
  };

  const scopeLabel = isEditingRegionOverride ? 'This region only' : 'Whole recording';
  const clearAction = isEditingRegionOverride
    ? selectedRegionOverride && (
        <button
          type="button"
          className="cursor-pointer text-[10px] font-[750] uppercase tracking-[0.1em] text-red-300/80 transition hover:text-red-300"
          onClick={() => {
            if (!selectedCursorRegion) {
              return;
            }

            void removeCursorRegionOverride(selectedCursorRegion.id);
          }}
        >
          Clear override
        </button>
      )
    : cursor.style === 'custom' &&
      cursor.customImagePath && (
        <button
          type="button"
          className="cursor-pointer text-[10px] font-[750] uppercase tracking-[0.1em] text-red-300/80 transition hover:text-red-300"
          onClick={() => void updateCursorConfig({ style: 'default', customImagePath: undefined })}
        >
          Reset
        </button>
      );

  return (
    <>
      {selectedCursorRegion ? (
        <div className="rounded-[14px] border border-[#5eead4]/35 bg-emerald-500/12 px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[10px] font-[750] uppercase tracking-[0.1em] text-[#5eead4]">
              Editing region
            </span>
            <span className="font-mono text-[11px] tabular-nums text-[#ccfbf1]/75">
              {formatMilliseconds(selectedCursorRegion.startMs)} –{' '}
              {formatMilliseconds(selectedCursorRegion.endMs)}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-[#ccfbf1]/60">
            Image changes apply only inside this region. Deselect it on the timeline to edit the
            whole recording.
          </p>
        </div>
      ) : null}

      <PanelSection title="Cursor image" action={clearAction || undefined}>
        <button
          type="button"
          onClick={() => void openCursorPicker()}
          className={cn(
            'grid h-20 w-full cursor-pointer place-items-center content-center gap-1.5 rounded-[14px] transition-colors',
            activeImage
              ? 'border border-white/10 bg-white/[0.03] hover:border-[#5eead4]/50'
              : 'border border-dashed border-white/15 text-white/45 hover:border-[#5eead4]/40 hover:text-white/70',
          )}
        >
          {activeImage ? (
            <img src={activeImage} alt="Custom cursor" className="size-10 object-contain" />
          ) : (
            <>
              <ImagePlus className="size-4" />
              <span className={PANEL_LABEL}>Choose a PNG or SVG</span>
            </>
          )}
        </button>

        <PanelNote>Applies to: {scopeLabel}</PanelNote>
      </PanelSection>

      <PanelSection title="Size">
        <PanelSlider
          label="Cursor size"
          value={cursor.size}
          min={0.2}
          max={3}
          step={0.1}
          onChange={handleSizeInput}
          format={(value) => `${value.toFixed(1)}x`}
        />
      </PanelSection>

      <PanelSection
        title="Cursor pack"
        action={
          cursorRegions.length > 0 ? (
            <span className={PANEL_LABEL}>{cursorTypeGroups.length} types</span>
          ) : undefined
        }
      >
        <PanelNote>
          Assign one image per detected cursor type, then apply it to every matching region at once.
        </PanelNote>

        {cursorTypeGroups.length === 0 ? (
          <PanelEmpty
            Icon={MousePointer2}
            title="No cursor types detected"
            hint="This project has no recorded cursor movement to group."
          />
        ) : (
          <div className="space-y-2">
            {cursorTypeGroups.map((group) => {
              const assignedPath = packAssignments[group.key]?.trim();
              const assignedPreviewSrc = toImageSrc(assignedPath);
              const previewSrc = assignedPreviewSrc ?? toImageSrc(group.sourceCursorDataUrl);

              return (
                <div
                  key={group.key}
                  className="flex items-center gap-2.5 rounded-[14px] border border-white/[0.07] bg-white/[0.025] px-2.5 py-2"
                >
                  {previewSrc ? (
                    <img
                      src={previewSrc}
                      alt={`${group.label} cursor preview`}
                      className="size-8 flex-none rounded-[8px] border border-white/10 bg-black/25 object-contain p-1"
                      title={assignedPreviewSrc ? 'Assigned replacement' : 'Detected source cursor'}
                    />
                  ) : (
                    <span
                      className="size-8 flex-none rounded-[8px] border border-dashed border-white/15 bg-black/25"
                      title="No cursor preview available"
                    />
                  )}

                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-[12px] font-[650] text-white/85">
                      {group.label}
                    </span>
                    <span className="text-[10px] text-white/35">
                      {group.regions.length} region{group.regions.length === 1 ? '' : 's'}
                    </span>
                  </span>

                  <button
                    type="button"
                    onClick={() => void assignPackImage(group.key)}
                    className="cursor-pointer rounded-[10px] border border-white/10 bg-white/[0.045] px-2.5 py-1.5 text-[11px] font-[650] text-white/70 transition hover:border-white/25 hover:bg-white/10 hover:text-white"
                  >
                    Choose
                  </button>
                  {assignedPath ? (
                    <button
                      type="button"
                      onClick={() => clearPackImage(group.key)}
                      title="Clear assignment"
                      aria-label={`Clear ${group.label} assignment`}
                      className="grid size-7 flex-none cursor-pointer place-items-center rounded-full text-white/40 transition hover:bg-white/10 hover:text-white"
                    >
                      <X className="size-3.5" />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <PanelButton
            disabled={cursorRegions.length === 0}
            onClick={loadPackFromExistingOverrides}
          >
            Load from timeline
          </PanelButton>
          <PanelButton disabled={!hasPackImage} onClick={() => setPackAssignments({})}>
            Clear pack
          </PanelButton>
        </div>

        <PanelButton
          tone="accent"
          disabled={
            (!hasPackImage && !hasExistingOverrides) || cursorRegions.length === 0 || isApplyingPack
          }
          onClick={() => void applyPackToTimeline()}
        >
          {isApplyingPack ? 'Applying…' : 'Apply pack to timeline'}
        </PanelButton>
      </PanelSection>
    </>
  );
}
