export default function Header({
  isRecording,
  view,
  selectedSource,
  isPaused,
}: {
  isRecording: boolean;
  view: 'ready' | 'selection';
  selectedSource: { name: string } | undefined;
  isPaused: boolean;
}) {
  return (
    <div className="space-y-2 mb-4 w-full flex flex-col items-center justify-center">
      {isRecording ? (
        <h1 className="text-7xl instrument-serif-regular-italic text-foreground tracking-tight">
          <span className="mr-4 tracking-tighter inter-thin">Recording</span>
          <span className="instrument-serif-regular-italic">in Progress</span>
        </h1>
      ) : view === 'ready' ? (
        <h1 className="text-7xl instrument-serif-regular-italic text-foreground tracking-tight">
          <span className="mr-4 tracking-tighter instrument-serif-regular-italic">Ready</span>
          <span className="tracking-tighter inter-thin">to Record</span>
        </h1>
      ) : (
        <h1 className="text-7xl text-foreground tracking-tight">
          <span className="mr-4 tracking-tighter inter-thin">New</span>
          <span className="instrument-serif-regular-italic">Recording</span>
        </h1>
      )}

      {!isRecording && !isPaused && (
        <p className="text-muted-foreground text-md">
          {view === 'ready'
            ? `Selected: ${selectedSource?.name || 'Unknown Source'}`
            : 'Select a screen or window to start'}
        </p>
      )}
    </div>
  );
}
