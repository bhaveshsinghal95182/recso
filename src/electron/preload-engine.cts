/**
 * The renderer half of the GPU video engine.
 *
 * This exists as its own preload module for one reason: a `VideoFrame` cannot
 * cross a contextBridge. The prototype this came from sidestepped that by
 * running with `nodeIntegration: true` and `contextIsolation: false`, which is
 * not a trade recso should make for a preview path.
 *
 * So the frame never leaves the isolated world. Preload registers the shared
 * texture receiver and paints each frame into a canvas that lives in the page.
 * The main world only ever touches that canvas -- an ordinary `<canvas>` it
 * can hand to `drawImage`, to Pixi, or to anything else taking a
 * `CanvasImageSource`.
 *
 *   main process          preload (isolated)          main world
 *   tick() ---------> receiver -> drawImage -> [ canvas ] -> Pixi / 2D
 *
 * The pixels stay on the GPU right up until that drawImage, and even then only
 * as far as the compositor.
 */

const electron = require('electron');

interface FrameInfo {
  format: string;
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  /** Microseconds, straight off the VideoFrame. */
  timestamp: number;
}

interface ImportedSharedTexture {
  getVideoFrame(): VideoFrame;
  release(): void;
}

/** The page canvas frames get painted into, once the main world binds one. */
let sink: HTMLCanvasElement | null = null;
let sinkContext: CanvasRenderingContext2D | null = null;

/**
 * Warm-up target. Reused so warming an 18-slot pool does not allocate 18
 * canvases, and tiny because nothing ever looks at it -- the point is only to
 * make the GPU process build its draw path now rather than mid-playback.
 */
let scratch: HTMLCanvasElement | null = null;

let lastFrame: FrameInfo | null = null;
let painted = 0;
let receiverInstalled = false;

function scratchCanvas(): HTMLCanvasElement {
  if (!scratch) {
    scratch = document.createElement('canvas');
    scratch.width = 16;
    scratch.height = 16;
  }
  return scratch;
}

/**
 * Why the receiver is not available, or null if it is.
 *
 * The usual cause is a sandboxed renderer: a sandboxed preload only gets a
 * polyfilled subset of the electron module -- ipcRenderer, contextBridge,
 * webFrame -- and `sharedTexture` is not in it. See the `sandbox: false` note
 * in `main.ts`.
 */
let receiverError: string | null = null;

/**
 * Register the receiver.
 *
 * Has to happen before the main process sends anything -- `sendSharedTexture`
 * throws after 1000ms if nothing is listening -- so this runs at preload time
 * and never unregisters. Binding a canvas later is fine; frames arriving
 * before then are still consumed and released, just not drawn.
 *
 * Every failure here is caught. This module is imported by the main preload,
 * so an exception escaping it takes `window.electron` with it and the whole
 * app dies -- the optional GPU path must never be able to do that to the path
 * everything else depends on.
 */
function installReceiver(): void {
  if (receiverInstalled || receiverError) {
    return;
  }

  if (typeof electron.sharedTexture?.setSharedTextureReceiver !== 'function') {
    receiverError =
      'electron.sharedTexture is unavailable in this preload. The renderer is ' +
      'most likely sandboxed; the engine preview needs sandbox: false.';
    return;
  }

  receiverInstalled = true;

  electron.sharedTexture.setSharedTextureReceiver(
    async (data: { importedSharedTexture: ImportedSharedTexture }, ...args: unknown[]) => {
      const imported = data.importedSharedTexture;
      const frame = imported.getVideoFrame();

      try {
        if (args[0] === 'warm') {
          scratchCanvas().getContext('2d')?.drawImage(frame, 0, 0, 16, 16);
          return;
        }

        if (sink && sinkContext) {
          // Size the canvas to the frame's *display* size, not its coded size:
          // decoders pad to macroblock alignment, and drawing the padding shows
          // up as a green strip along an edge.
          if (sink.width !== frame.displayWidth) {
            sink.width = frame.displayWidth;
          }
          if (sink.height !== frame.displayHeight) {
            sink.height = frame.displayHeight;
          }

          sinkContext.drawImage(frame, 0, 0);
        }

        lastFrame = {
          format: frame.format ?? 'unknown',
          codedWidth: frame.codedWidth,
          codedHeight: frame.codedHeight,
          displayWidth: frame.displayWidth,
          displayHeight: frame.displayHeight,
          timestamp: frame.timestamp,
        };
        painted += 1;
      } finally {
        // Both references must go, or the GPU resource stays alive and the
        // texture pool eventually stalls waiting for a free slot.
        frame.close();
        imported.release();
      }
    },
  );
}

try {
  installReceiver();
} catch (error) {
  receiverError = 'setSharedTextureReceiver failed: ' + (error as Error).message;
}

// Report through IPC rather than console: this runs before the main preload
// installs its console forwarding, and whether the receiver came up is exactly
// the thing you want in the log when the preview is mysteriously black.
electron.ipcRenderer.send(
  'logging:write',
  receiverError ? 'warn' : 'info',
  '[engine] shared-texture receiver',
  receiverError ?? 'installed',
);

const invoke = electron.ipcRenderer.invoke.bind(electron.ipcRenderer);

export const engineBridge = {
  /**
   * Never throws. The renderer calls this first to decide whether to offer the
   * GPU path at all -- a checkout where the Rust was never built, or a
   * renderer that cannot receive shared textures, reports `available: false`
   * and everything else in recso stays untouched.
   */
  status: async () => {
    const status = await invoke('engine:status');

    // The addon loading is only half of it. Without a receiver the main
    // process can decode perfectly and still have nowhere to put a frame, so
    // that counts as unavailable too.
    if (receiverError) {
      return { ...status, available: false, error: receiverError };
    }
    return status;
  },
  diagnostics: () => invoke('engine:diagnostics'),
  probe: (path: string) => invoke('engine:probe', path),
  gpuMemory: () => invoke('engine:gpu-memory'),

  /**
   * Point the receiver at a canvas in the page.
   *
   * Takes a selector rather than the element because DOM nodes cannot cross the
   * contextBridge. The main world creates the canvas, keeps its own reference
   * for drawing, and passes the selector here so preload finds the same node.
   */
  bindFrameSink: (selector: string): boolean => {
    const element = document.querySelector(selector);

    if (!(element instanceof HTMLCanvasElement)) {
      sink = null;
      sinkContext = null;
      return false;
    }

    sink = element;
    // willReadFrequently because the verification path reads this back, and
    // without it Chromium keeps promoting and demoting the backing store.
    sinkContext = element.getContext('2d', { willReadFrequently: true });
    return sinkContext !== null;
  },

  unbindFrameSink: (): void => {
    sink = null;
    sinkContext = null;
  },

  /** Metadata for the most recent painted frame, plus a monotonic paint count. */
  frameInfo: (): { frame: FrameInfo | null; painted: number } => ({
    frame: lastFrame,
    painted,
  }),

  player: {
    /**
     * `extras` carries the camera sidecar and the canvas to compose onto. The
     * canvas is fixed for the player's life, because it is the size of the
     * textures handed to Chromium.
     */
    open: (
      path: string,
      extras?: { webcamPath?: string; canvasWidth?: number; canvasHeight?: number },
    ) => invoke('engine:player:open', path, extras),
    /**
     * Open a recording by id, using the metadata the recorder stored with it.
     * No probe, and any disagreement with the container is reported back.
     */
    openRecording: (recordingId: string) => invoke('engine:player:open-recording', recordingId),
    close: () => invoke('engine:player:close'),
    /** Costs a few hundred ms once, and saves a stall in the first second. */
    warm: () => invoke('engine:player:warm'),
    play: () => invoke('engine:player:play'),
    pause: () => invoke('engine:player:pause'),
    setRate: (rate: number) => invoke('engine:player:rate', rate),
    /** `exact: false` while dragging a scrubber, `true` on release. */
    seek: (ms: number, exact = true) => invoke('engine:player:seek', ms, exact),
    /** Pulls the frame due now. Drive this from a RAF loop. */
    tick: () => invoke('engine:player:tick'),
    /** Grade the video layer. The webcam has its own -- see below. */
    setEffects: (brightness: number, contrast: number, saturation: number) =>
      invoke('engine:player:effects', brightness, contrast, saturation),
    /** Grade the webcam layer. */
    setWebcamEffects: (brightness: number, contrast: number, saturation: number) =>
      invoke('engine:player:webcam-effects', brightness, contrast, saturation),
    stats: () => invoke('engine:player:stats'),

    // ---- composition ----------------------------------------------------
    //
    // Each of these re-renders the frames already queued rather than going back
    // to the decoder, so they are cheap enough to drive from a drag.

    /** Place the webcam box, in the screen recording's own pixels. */
    setWebcamLayout: (layout: Record<string, unknown>) =>
      invoke('engine:player:webcam-layout', layout),
    /** Place the recording on the canvas: rect, corner radius, border. */
    setLayout: (placement: Record<string, unknown>) => invoke('engine:player:layout', placement),
    /**
     * Set the zoom/pan timeline. The video and cursor move with it; the
     * background and webcam do not.
     */
    setZoomRegions: (regions: unknown[]) => invoke('engine:player:zoom-regions', regions),
    /**
     * Remove spans of the recording. Regions are in source time; everything the
     * player reports afterwards is in composition time.
     */
    setCuts: (regions: unknown[]) => invoke('engine:player:cuts', regions),
    /** Throw away the edges of the recording. `null` keeps all of it. */
    setSourceCrop: (crop: Record<string, unknown> | null) =>
      invoke('engine:player:source-crop', crop),
    /** The edit's length: the file's duration less what has been cut. */
    compositionDuration: () => invoke('engine:player:composition-duration'),
    /**
     * What fills the canvas behind the video.
     *
     * `image.pixels` must be an ArrayBuffer, same rule as the cursor bitmap: a
     * Buffer or typed array is structured-cloned into something the main
     * process cannot hand straight to the addon.
     */
    setBackground: (background: Record<string, unknown>) =>
      invoke('engine:player:background', background),
    hasWebcam: () => invoke('engine:player:has-webcam'),

    /**
     * `pixels` must be an ArrayBuffer. A Buffer or typed array would be
     * structured-cloned into something the main process cannot hand straight to
     * the addon.
     */
    setCursorImage: (
      image: {
        width: number;
        height: number;
        pixels: ArrayBuffer;
        hotspotX?: number;
        hotspotY?: number;
      } | null,
    ) => invoke('engine:player:cursor-image', image),
    /** The per-sample bitmap table. `pixels` must be ArrayBuffers, as above. */
    setCursorImages: (
      images: {
        width: number;
        height: number;
        pixels: ArrayBuffer;
        hotspotX?: number;
        hotspotY?: number;
      }[],
    ) => invoke('engine:player:cursor-images', images),
    setCursorTrack: (samples: unknown[]) => invoke('engine:player:cursor-track', samples),
    setCursorStyle: (size: number, opacity: number) =>
      invoke('engine:player:cursor-style', size, opacity),
    setCursorEffects: (effects: {
      clickScale?: number;
      clickDurationMs?: number;
      smearStrength?: number;
    }) => invoke('engine:player:cursor-effects', effects),
    cursorSampleCount: () => invoke('engine:player:cursor-sample-count'),
    cursorImageCount: () => invoke('engine:player:cursor-image-count'),

    /** The composited frame as raw BGRA. Stalls the GPU; for stills, not playback. */
    snapshot: () => invoke('engine:player:snapshot'),
  },

  export: {
    start: (input: string, options: Record<string, unknown>) =>
      invoke('engine:export:start', input, options),
    progress: () => invoke('engine:export:progress'),
    cancel: () => invoke('engine:export:cancel'),
  },

  /**
   * Read the sink back and describe it.
   *
   * An all-black canvas looks identical to success from every other vantage
   * point -- main reports a successful send, the receiver reports a painted
   * frame -- so anything verifying the pipeline unattended needs this to tell
   * the difference.
   */
  inspectFrameSink: () => {
    if (!sink || !sinkContext) {
      return { error: 'no sink bound' };
    }

    try {
      const { data } = sinkContext.getImageData(0, 0, sink.width, sink.height);
      const distinct = new Set<string>();
      let nonBlack = 0;

      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) {
          nonBlack += 1;
        }
        if (distinct.size < 64) {
          distinct.add(String(data[i]) + ',' + String(data[i + 1]) + ',' + String(data[i + 2]));
        }
      }

      const pixels = data.length / 4;
      const centre = ((sink.height >> 1) * sink.width + (sink.width >> 1)) * 4;

      return {
        pixels,
        nonBlackPct: Number(((nonBlack / pixels) * 100).toFixed(2)),
        distinctColours: distinct.size,
        centrePixel: [data[centre], data[centre + 1], data[centre + 2]],
      };
    } catch (error) {
      return { error: 'readback failed: ' + (error as Error).message };
    }
  },
};
