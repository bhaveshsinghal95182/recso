interface WelcomeScreenProps {
  onNewRecording: () => void;
  onOpenProject: () => void;
}

export function WelcomeScreen({ onNewRecording, onOpenProject }: WelcomeScreenProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center select-none relative overflow-hidden bg-background">
      {/* Background Half-Circle Gradient */}
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[800px] h-[350px] bg-brand/10 blur-[120px] rounded-t-full pointer-events-none z-0" />
      <div className="absolute top-1/4 left-1/4 w-[400px] h-[400px] bg-brand/5 blur-[100px] rounded-full pointer-events-none z-0" />

      <div className="mb-14 text-center relative z-10 animate-in fade-in slide-in-from-bottom-4 duration-1000">
        <h1 className="text-8xl instrument-serif-regular-italic mb-2 text-transparent bg-clip-text bg-linear-to-b from-foreground to-foreground/60 drop-shadow-sm">
          Recso
        </h1>
        <p className="text-muted-foreground text-sm uppercase tracking-[0.25em] font-light">
          Screen Recorder & Editor
        </p>
      </div>

      <div className="flex gap-8 relative z-10 animate-in fade-in slide-in-from-bottom-8 duration-1000 delay-150">
        {/* Hexagon New Recording (Brand Color) */}
        <button
          onClick={onNewRecording}
          className="group relative w-64 h-40 transition-all duration-500 cursor-pointer drop-shadow-none hover:drop-shadow-[0_0_30px_rgba(52,211,153,0.3)] hover:-translate-y-2 focus:outline-none"
        >
          <div
            className="w-full h-full bg-white/3 backdrop-blur-xl group-hover:bg-white/5 transition-all duration-500 flex flex-col items-center justify-center gap-4 relative overflow-hidden"
            style={{ clipPath: 'polygon(15% 0, 85% 0, 100% 50%, 85% 100%, 15% 100%, 0 50%)' }}
          >
            {/* Inner hover glow */}
            <div className="absolute inset-0 bg-linear-to-b from-brand/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

            <div className="relative z-10 w-12 h-12 rounded-full bg-brand/10 flex items-center justify-center group-hover:bg-brand/20 transition-all duration-500 group-hover:scale-110 shadow-[0_0_15px_rgba(52,211,153,0.1)]">
              <div className="w-4 h-4 bg-brand rounded-full shadow-[0_0_12px_rgba(52,211,153,0.8)]" />
            </div>

            <div className="relative z-10 text-center px-4">
              <h3 className="font-semibold text-lg mb-1 text-foreground/90 group-hover:text-brand-light transition-colors duration-500">
                New Recording
              </h3>
              <p className="text-sm text-muted-foreground/70 group-hover:text-muted-foreground transition-colors duration-500">
                Record screen or camera
              </p>
            </div>
          </div>
        </button>

        {/* Hexagon Open Project */}
        <button
          onClick={onOpenProject}
          className="group relative w-64 h-40 transition-all duration-500 cursor-pointer drop-shadow-none hover:drop-shadow-[0_0_30px_rgba(255,255,255,0.15)] hover:-translate-y-2 focus:outline-none"
        >
          <div
            className="w-full h-full bg-white/3 backdrop-blur-xl group-hover:bg-white/5 transition-all duration-500 flex flex-col items-center justify-center gap-4 relative overflow-hidden"
            style={{ clipPath: 'polygon(15% 0, 85% 0, 100% 50%, 85% 100%, 15% 100%, 0 50%)' }}
          >
            {/* Inner hover glow */}
            <div className="absolute inset-0 bg-linear-to-b from-white/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

            <div className="relative z-10 w-12 h-12 rounded-full bg-white/5 flex items-center justify-center group-hover:bg-white/10 transition-all duration-500 group-hover:scale-110 shadow-[0_0_15px_rgba(255,255,255,0.05)]">
              <span className="text-2xl drop-shadow-[0_0_8px_rgba(255,255,255,0.2)] group-hover:drop-shadow-[0_0_15px_rgba(255,255,255,0.5)] transition-all">
                📂
              </span>
            </div>

            <div className="relative z-10 text-center px-4">
              <h3 className="font-semibold text-lg mb-1 text-foreground/90 transition-colors duration-500 group-hover:text-foreground">
                Open Project
              </h3>
              <p className="text-sm text-muted-foreground/70 group-hover:text-muted-foreground transition-colors duration-500">
                Edit existing .recso project
              </p>
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}
