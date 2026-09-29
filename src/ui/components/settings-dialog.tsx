import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { Switch } from '@/components/ui/switch';
import type { AutomationState } from '@/electron.d.ts';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

/** recso's settings. For now one section: Advanced ▸ Automation API. */
export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  // A portal: the titlebar's backdrop blur would otherwise contain this fixed overlay.
  return createPortal(
    <div
      className="fixed inset-0 z-2000 flex items-center justify-center bg-black/60 backdrop-blur-sm [-webkit-app-region:no-drag]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="w-[min(520px,calc(100vw-32px))] rounded-2xl border border-white/10 bg-background shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h2 id="settings-title" className="text-base font-semibold text-foreground">
            Settings
          </h2>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground cursor-pointer"
            title="Close"
          >
            <X size={16} />
          </button>
        </header>
        <section className="px-5 py-4">
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/60">
            Advanced
          </h3>
          <AutomationApiSetting />
        </section>
      </div>
    </div>,
    document.body,
  );
}

function AutomationApiSetting() {
  const [state, setState] = useState<AutomationState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    window.electron.automation.getState().then((next) => {
      if (live) setState(next);
    });
    const unsubscribe = window.electron.automation.onState(setState);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      setState(await window.electron.automation.setEnabled(enabled));
    } finally {
      setBusy(false);
    }
  };

  const running = state?.running ?? false;
  return (
    <div className="rounded-xl border border-white/10 bg-white/3 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor="automation-api" className="text-sm font-medium text-foreground">
            Automation API
          </label>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Lets scripts and AI agents on this computer, running as you, control recso: start and
            stop recordings, open projects and export them. Use it with{' '}
            <code className="font-mono">recso-cli</code> or its MCP server.
          </p>
        </div>
        <Switch
          id="automation-api"
          checked={running}
          disabled={busy || state === null}
          onCheckedChange={(checked) => void toggle(checked)}
        />
      </div>
      {running && state && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span
            className={
              state.connections > 0
                ? 'rounded-full bg-brand/15 px-2 py-0.5 font-medium text-brand-light'
                : 'rounded-full bg-white/5 px-2 py-0.5 text-muted-foreground'
            }
          >
            {state.connections > 0
              ? `API connected${state.connections > 1 ? ` (${state.connections})` : ''}`
              : 'Listening'}
          </span>
          <code className="min-w-0 truncate font-mono text-muted-foreground/70" title={state.path}>
            {state.path}
          </code>
        </div>
      )}
      {state?.error && <p className="mt-3 text-xs text-red-400">Couldn't start: {state.error}</p>}
      {state?.override && (
        <p className="mt-3 text-xs text-muted-foreground/70">
          RECSO_AUTOMATION={state.override === 'on' ? '1' : '0'} is set, so recso turns it{' '}
          {state.override} at every launch whatever this switch says.
        </p>
      )}
    </div>
  );
}
