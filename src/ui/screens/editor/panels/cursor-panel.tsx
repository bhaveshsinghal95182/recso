import { ImagePlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  type CursorTimelineRegion,
  deriveCursorTimelineRegions,
  resolveCursorRegionKey,
} from '@/screens/editor/cursor-timeline-regions';
import { useProjectStore } from '@/store/project-store';
import { useTimelineStore } from '@/store/timeline-store';
import type { CursorRegionOverride } from '@/types';

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
  const { selectedCursorRegionId } = useTimelineStore();
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

  return (
    <div className="space-y-6">
      {selectedCursorRegion ? (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          <div className="font-semibold uppercase tracking-[0.08em]">
            Editing Selected Cursor Region
          </div>
          <div className="text-emerald-100/80 mt-1">
            {formatMilliseconds(selectedCursorRegion.startMs)} -{' '}
            {formatMilliseconds(selectedCursorRegion.endMs)}
          </div>
          <div className="text-emerald-100/70 mt-1">
            Custom image changes apply only inside this timeline region.
          </div>
        </div>
      ) : null}

      <div className="space-y-3 rounded-md border border-border/60 p-3 bg-muted/10">
        <div className="flex items-center justify-between gap-2">
          <div>
            <Label>Cursor Pack</Label>
            <p className="text-[11px] text-muted-foreground mt-1">
              Assign one image per detected cursor type, then apply the pack to all matching
              regions.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => void applyPackToTimeline()}
            disabled={
              (!hasPackImage && !hasExistingOverrides) ||
              cursorRegions.length === 0 ||
              isApplyingPack
            }
          >
            {isApplyingPack ? 'Applying...' : 'Apply Pack'}
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={loadPackFromExistingOverrides}
            disabled={cursorRegions.length === 0}
          >
            Load From Timeline
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPackAssignments({})}
            disabled={!hasPackImage}
          >
            Clear Pack
          </Button>
        </div>

        {cursorTypeGroups.length === 0 ? (
          <div className="text-[11px] text-muted-foreground">No cursor types detected yet.</div>
        ) : (
          <div className="space-y-2">
            {cursorTypeGroups.map((group) => {
              const assignedPath = packAssignments[group.key]?.trim();
              const assignedPreviewSrc = toImageSrc(assignedPath);
              const detectedPreviewSrc = toImageSrc(group.sourceCursorDataUrl);
              const previewSrc = assignedPreviewSrc ?? detectedPreviewSrc;

              return (
                <div
                  key={group.key}
                  className="rounded-md border border-border/50 bg-background/40 px-2 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-medium">{group.label}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {group.regions.length} timeline region
                        {group.regions.length === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {previewSrc ? (
                        <img
                          src={previewSrc}
                          alt={`${group.label} cursor preview`}
                          className="h-7 w-7 rounded-sm border border-border/70 object-contain bg-muted/20"
                          title={
                            assignedPreviewSrc
                              ? 'Assigned replacement cursor'
                              : 'Detected source cursor'
                          }
                        />
                      ) : (
                        <div
                          className="h-7 w-7 rounded-sm border border-dashed border-border/70 bg-muted/20"
                          title="No cursor preview available"
                        />
                      )}

                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void assignPackImage(group.key)}
                      >
                        Choose
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => clearPackImage(group.key)}
                        disabled={!assignedPath}
                      >
                        Clear
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>
            {isEditingRegionOverride ? 'Region Cursor PNG/SVG' : 'Global Cursor PNG/SVG'}
          </Label>
          {isEditingRegionOverride
            ? selectedRegionOverride && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px] text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => {
                    if (!selectedCursorRegion) {
                      return;
                    }

                    void removeCursorRegionOverride(selectedCursorRegion.id);
                  }}
                >
                  Clear Override
                </Button>
              )
            : cursor.style === 'custom' &&
              cursor.customImagePath && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px] text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() =>
                    void updateCursorConfig({ style: 'default', customImagePath: undefined })
                  }
                >
                  Reset
                </Button>
              )}
        </div>

        {activeImage ? (
          <button
            type="button"
            onClick={() => {
              void openCursorPicker();
            }}
            className="w-full h-16 rounded-md border border-border/60 bg-muted/10 hover:bg-muted/30 hover:border-primary/50 transition-colors flex items-center justify-center"
          >
            <img src={activeImage} alt="Custom cursor" className="h-10 w-10 object-contain" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              void openCursorPicker();
            }}
            className="w-full h-16 rounded-md border border-dashed border-border/60 hover:border-primary/50 flex flex-col items-center justify-center gap-1 cursor-pointer transition-colors bg-muted/10 hover:bg-muted/30"
          >
            <ImagePlus className="w-4 h-4 text-muted-foreground/70" />
            <span className="text-[11px] text-muted-foreground font-medium">
              Choose PNG/SVG file
            </span>
          </button>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="cursor-size">Cursor Size</Label>
        <div className="flex items-center gap-2">
          <input
            id="cursor-size-slider"
            type="range"
            min="0.2"
            max="3"
            step="0.1"
            value={cursor.size}
            onChange={(e) => handleSizeInput(Number(e.target.value))}
            className="flex-1"
          />
          <Input
            id="cursor-size"
            type="number"
            min="0.2"
            max="3"
            step="0.1"
            value={cursor.size}
            onChange={(e) => handleSizeInput(Number(e.target.value))}
            className="w-20 font-mono text-xs h-8"
          />
        </div>
      </div>
    </div>
  );
}
