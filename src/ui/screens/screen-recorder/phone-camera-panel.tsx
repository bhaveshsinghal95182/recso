import { AlertTriangle, Check, Loader2, RefreshCw, Smartphone } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { PhoneCameraState } from '@/electron.js';
import { cn } from '@/lib/utils';

/**
 * Pair a phone as the camera.
 *
 * The desktop serves a page over the local network; this shows the code that
 * gets you there and then reports whether frames are actually arriving. That
 * second half is the part that matters -- pairing has several ways to half-work
 * (wrong network, permission refused, the browser backgrounded) and every one of
 * them looks identical from here unless the panel says otherwise.
 */

/** How often to ask whether frames are still coming. */
const POLL_MS = 700;

interface PhoneCameraPanelProps {
  /** Whether the phone is the selected camera. */
  active: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
}

export function PhoneCameraPanel({ active, onActivate, onDeactivate }: PhoneCameraPanelProps) {
  const [state, setState] = useState<PhoneCameraState | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [addressIndex, setAddressIndex] = useState(0);
  const pollRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      await window.electron.phoneCamera.start();
      setState(await window.electron.phoneCamera.state());
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }, []);

  useEffect(() => {
    if (!active) {
      stopPolling();
      return;
    }

    void start();
    pollRef.current = window.setInterval(() => {
      void window.electron.phoneCamera.state().then(setState);
    }, POLL_MS);

    return stopPolling;
  }, [active, start, stopPolling]);

  // Deliberately not stopped when the panel unmounts. The user closes this to go
  // and press record, and tearing the server down at that moment would drop the
  // phone they just finished pairing.

  const address = state?.urls[addressIndex] ?? state?.url ?? null;
  const qr = useMemo(() => (address ? qrSvgPath(address) : null), [address]);
  const live = state?.live ?? false;

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={active ? onDeactivate : onActivate}
        className={cn(
          'flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition',
          active
            ? 'border-white/20 bg-white/10'
            : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]',
        )}
      >
        <Smartphone size={18} className="shrink-0 opacity-80" />
        <span className="flex flex-1 flex-col">
          <span className="text-sm font-medium">Use my phone</span>
          <span className="text-xs opacity-60">
            {active ? 'Scan the code below' : 'Stream your phone camera over wifi'}
          </span>
        </span>
        {active && live && <Check size={16} className="shrink-0 text-emerald-400" />}
        {active && !live && <Loader2 size={16} className="shrink-0 animate-spin opacity-50" />}
      </button>

      {active && (
        <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          {starting && !state && (
            <p className="text-xs opacity-60">Starting the pairing server&hellip;</p>
          )}

          {startError && <Problem>{startError}</Problem>}

          {address && qr && (
            <div className="flex gap-4">
              {/* White quiet zone included: a QR on a dark ground does not scan. */}
              <div className="shrink-0 rounded-lg bg-white p-2">
                <svg
                  viewBox={`0 0 ${qr.size} ${qr.size}`}
                  // 33 modules for a typical pairing URL, so this is ~5px a
                  // module -- enough for a phone to lock on from arm's length.
                  width={160}
                  height={160}
                  shapeRendering="crispEdges"
                  aria-label="Pairing code"
                >
                  <path d={qr.path} fill="#000" />
                </svg>
              </div>

              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Status live={live} state={state} />

                <p className="text-xs leading-relaxed opacity-60">
                  Scan with your phone&rsquo;s camera. It will warn you the connection is not
                  private &mdash; that is expected, the certificate is made on this machine. Tap
                  through it, then tap{' '}
                  <strong className="font-medium opacity-90">Start camera</strong>.
                </p>

                <code className="truncate rounded-md bg-black/30 px-2 py-1 font-mono text-[11px] opacity-50">
                  {address.replace(/\?t=.*/, '')}
                </code>

                {(state?.urls.length ?? 0) > 1 && (
                  <button
                    type="button"
                    onClick={() => setAddressIndex((index) => (index + 1) % state!.urls.length)}
                    className="flex items-center gap-1.5 self-start text-xs opacity-60 hover:opacity-100"
                  >
                    <RefreshCw size={12} />
                    Not working? Try another address ({addressIndex + 1}/{state!.urls.length})
                  </button>
                )}
              </div>
            </div>
          )}

          {state?.lastError && <Problem>{state.lastError}</Problem>}
        </div>
      )}
    </div>
  );
}

function Status({ live, state }: { live: boolean; state: PhoneCameraState | null }) {
  if (live) {
    return (
      <p className="flex items-center gap-2 text-xs font-medium text-emerald-400">
        <span className="size-2 rounded-full bg-emerald-400" />
        Connected &mdash; {state?.width}&times;{state?.height}
      </p>
    );
  }

  return (
    <p className="flex items-center gap-2 text-xs opacity-60">
      <span className="size-2 rounded-full bg-white/30" />
      {state && state.framesReceived > 0 ? 'The phone stopped sending' : 'Waiting for the phone'}
    </p>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
      <AlertTriangle size={13} className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/**
 * The QR as one SVG path, so it renders without a canvas or an image.
 *
 * Every dark module becomes a 1x1 rectangle in the path. Adjacent squares share
 * edges and the renderer draws them as a single filled region, which avoids the
 * hairline seams a grid of separate `<rect>`s picks up at fractional scales --
 * and a seam through a finder pattern is exactly the kind of thing that makes a
 * code scan on one phone and not another.
 */
function qrSvgPath(text: string): { path: string; size: number } {
  // Type 0 lets the library pick the smallest version that fits. Error
  // correction M: enough to survive a phone camera at an angle without inflating
  // the module count, which is what makes a code hard to scan from a distance.
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const parts: string[] = [];

  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (qr.isDark(row, column)) {
        parts.push(`M${column} ${row}h1v1h-1z`);
      }
    }
  }

  return { path: parts.join(''), size: count };
}
