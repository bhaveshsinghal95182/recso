interface WelcomeScreenProps {
  onNewRecording: () => void;
  onOpenProject: () => void;
}

export function WelcomeScreen({ onNewRecording, onOpenProject }: WelcomeScreenProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center select-none">
      <div className="mb-12 text-center animate-in fade-in slide-in-from-bottom-4 duration-700">
        <h1 className="text-6xl font-bold tracking-tighter mb-4 bg-linear-to-br from-white to-white/50 bg-clip-text text-transparent">
          RecSO
        </h1>
        <p className="text-muted-foreground text-lg">Screen Recorder & Editor</p>
      </div>

      <div className="flex gap-6 animate-in fade-in slide-in-from-bottom-8 duration-700 delay-100">
        <button
          onClick={onNewRecording}
          className="group relative w-64 h-40 bg-card border border-border rounded-xl p-6 flex flex-col items-center justify-center gap-4 hover:bg-accent/50 hover:border-primary/50 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl cursor-pointer"
        >
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
            <div className="w-4 h-4 bg-primary rounded-full shadow-[0_0_10px_rgba(255,255,255,0.5)]" />
          </div>
          <div className="text-center">
            <h3 className="font-semibold text-lg mb-1">New Recording</h3>
            <p className="text-sm text-muted-foreground">Record screen or camera</p>
          </div>
        </button>

        <button
          onClick={onOpenProject}
          className="group relative w-64 h-40 bg-card border border-border rounded-xl p-6 flex flex-col items-center justify-center gap-4 hover:bg-accent/50 hover:border-blue-500/50 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl cursor-pointer"
        >
          <div className="w-12 h-12 rounded-full bg-blue-500/10 flex items-center justify-center group-hover:bg-blue-500/20 transition-colors">
            <span className="text-2xl">📂</span>
          </div>
          <div className="text-center">
            <h3 className="font-semibold text-lg mb-1">Open Project</h3>
            <p className="text-sm text-muted-foreground">Edit existing .recso project</p>
          </div>
        </button>
      </div>

      <div className="absolute bottom-8 text-xs text-muted-foreground/50">
        v0.1.0 • Built with Electron & React
      </div>
    </div>
  );
}
