import { TimeRuler } from '@/components/screens/editor/timeline/time-ruler';
import { TrackRow } from '@/components/screens/editor/timeline/track-row';
import { useEditor } from '@/context/editor-context';

export function TimelineContainer() {
  const { project, currentTime, duration, seek } = useEditor();

  if (!project) return null;

  // Calculate playhead position as percentage
  const playheadPosition = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="h-full flex flex-col">
      <TimeRuler duration={duration} onSeek={seek} />

      <div className="flex-1 overflow-y-auto relative">
        {/* Playhead */}
        <div
          className="absolute top-0 w-0.5 h-full bg-destructive z-10 pointer-events-none"
          style={{ left: `calc(120px + ${playheadPosition}% * (100% - 120px) / 100)` }}
        />

        {/* Video track */}
        <TrackRow label="Video" icon="🎬" hasClip clipStart={0} clipEnd={100} />

        {/* Cursor track */}
        <TrackRow label="Cursor" icon="🖱️" hasClip clipStart={0} clipEnd={100} />

        {/* Audio track (placeholder) */}
        <TrackRow label="Audio" icon="🔊" hasClip={false} />
      </div>
    </div>
  );
}
