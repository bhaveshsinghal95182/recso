/**
 * TrackRow — A single row in the timeline representing a track.
 */

interface TrackRowProps {
  label: string;
  icon: string;
  hasClip: boolean;
  clipStart?: number;
  clipEnd?: number;
}

export function TrackRow({ label, icon, hasClip, clipStart = 0, clipEnd = 100 }: TrackRowProps) {
  return (
    <div className="flex h-12 border-b border-border">
      <div className="w-[120px] px-4 py-3 text-xs text-muted-foreground bg-sidebar flex items-center gap-2 border-r border-border">
        <span>{icon}</span>
        <span>{label}</span>
      </div>
      <div className="flex-1 relative bg-[linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-size-[60px_100%]">
        {hasClip && (
          <div
            className="absolute top-1 h-[calc(100%-8px)] bg-primary/80 rounded"
            style={{
              left: `${clipStart}%`,
              width: `${clipEnd - clipStart}%`,
            }}
          />
        )}
      </div>
    </div>
  );
}
