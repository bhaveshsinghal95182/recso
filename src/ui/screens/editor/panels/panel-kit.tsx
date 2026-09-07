/**
 * Panel kit
 *
 * Shared primitives for the editor's properties panels. Every panel used to
 * hand-roll its own labels, rows and option grids, so they drifted apart. These
 * follow the recorder toolbar's language: neutral glass surfaces, 10px uppercase
 * section labels, and emerald reserved for "this one is selected".
 */

import type { ComponentType, ReactNode } from 'react';

import { cn } from '@/lib/utils';

export const PANEL_LABEL =
  'text-[10px] font-[750] uppercase tracking-[0.1em] text-white/45 leading-none';

const OPTION_BASE =
  'cursor-pointer rounded-[14px] border border-white/10 bg-white/[0.045] text-white/60 transition duration-150 hover:border-white/20 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40';
const OPTION_ACTIVE = 'border-[#5eead4]/35 bg-emerald-500/15 text-[#ccfbf1] hover:text-[#ccfbf1]';

/** A titled group of controls, with an optional trailing action or readout. */
export function PanelSection({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('space-y-2.5', className)}>
      <header className="flex min-h-5 items-center justify-between gap-3">
        <h4 className={PANEL_LABEL}>{title}</h4>
        {action}
      </header>
      {children}
    </section>
  );
}

/** A label above its control, for anything that needs more room than a row. */
export function PanelField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <span className={cn(PANEL_LABEL, 'block')}>{label}</span>
      {children}
      {hint ? <p className="text-[11px] leading-snug text-white/35">{hint}</p> : null}
    </div>
  );
}

/** Label and description on the left, a control on the right. */
export function PanelRow({
  label,
  hint,
  control,
  className,
}: {
  label: string;
  hint?: string;
  control: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-[14px] border border-white/[0.07] bg-white/[0.025] px-3 py-2.5',
        className,
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <span className="block text-[13px] font-[650] text-white/85">{label}</span>
        {hint ? <p className="text-[11px] leading-snug text-white/35">{hint}</p> : null}
      </div>
      <div className="flex-none">{control}</div>
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/** Exclusive choice as a pill group — the recorder's All/Screens/Windows filter. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="flex gap-1 rounded-[14px] border border-white/[0.07] bg-black/30 p-[4px]"
      role="radiogroup"
    >
      {options.map((option) => {
        const isActive = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            title={option.hint ?? option.label}
            disabled={disabled || option.disabled}
            className={cn(
              'flex-1 cursor-pointer rounded-[10px] px-2 py-[7px] text-[12px] font-[700] text-white/50 transition duration-150 hover:text-white/85 disabled:cursor-not-allowed disabled:opacity-40',
              isActive && 'bg-white/10 text-white hover:text-white',
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A reference point drawn on a slider's track. Absolute sliders ("webcam height
 * is 40% of the canvas") are hard to read on their own because nothing tells you
 * where the value you started from sits, so a marker turns the track into a
 * before/after comparison: left of the tick shrinks, right of it grows.
 */
export interface PanelSliderMarker {
  value: number;
  /** Shown under the tick. Keep it to a word or two - the track is narrow. */
  label?: string;
}

/** Width of the range thumb in px, mirroring `size-3.5` in the class list. */
const SLIDER_THUMB_PX = 14;

/**
 * The browser insets a range thumb by half its width at each end, so a raw
 * percentage lands the marker slightly off from where the thumb actually stops.
 * This applies the same inset the thumb gets.
 */
function markerOffset(value: number, min: number, max: number): string {
  const span = max - min;
  const fraction = span <= 0 ? 0 : Math.max(0, Math.min(1, (value - min) / span));

  return `calc(${fraction * 100}% + ${(0.5 - fraction) * SLIDER_THUMB_PX}px)`;
}

/** Range input with a monospace readout, sharing one value formatter. */
export function PanelSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  disabled,
  hint,
  marker,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format: (value: number) => string;
  disabled?: boolean;
  hint?: string;
  marker?: PanelSliderMarker;
}) {
  const showMarker = Boolean(marker && marker.value >= min && marker.value <= max);

  return (
    <div className={cn('space-y-2', disabled && 'opacity-40')}>
      <div className="flex items-baseline justify-between gap-3">
        <span className={PANEL_LABEL}>{label}</span>
        <span className="font-mono text-[12px] tabular-nums text-white/80">{format(value)}</span>
      </div>

      <div className={cn('relative', showMarker && marker?.label && 'pb-4')}>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={label}
          onChange={(event) => onChange(Number(event.target.value))}
          className={cn(
            'relative z-10 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/10 disabled:cursor-not-allowed',
            '[&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full',
            '[&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-white/30 [&::-webkit-slider-thumb]:bg-white',
            '[&::-webkit-slider-thumb]:shadow-[0_1px_4px_rgba(0,0,0,0.5)] [&::-webkit-slider-thumb]:transition',
            '[&::-webkit-slider-thumb]:hover:border-[#5eead4]/60',
          )}
        />

        {marker && showMarker && (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute top-1/2 z-0 h-3 w-px -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#5eead4]/70"
              style={{ left: markerOffset(marker.value, min, max) }}
            />
            {marker.label ? (
              <span
                aria-hidden
                className="pointer-events-none absolute top-[calc(50%+9px)] z-0 -translate-x-1/2 whitespace-nowrap text-[10px] leading-none text-[#5eead4]/60"
                style={{ left: markerOffset(marker.value, min, max) }}
              >
                {marker.label}
              </span>
            ) : null}
          </>
        )}
      </div>

      {hint ? <p className="text-[11px] leading-snug text-white/35">{hint}</p> : null}
    </div>
  );
}

/** Icon tiles in a grid — shape and size pickers. */
export function OptionGrid({ columns = 4, children }: { columns?: number; children: ReactNode }) {
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0,1fr))` }}
    >
      {children}
    </div>
  );
}

export function OptionTile({
  label,
  Icon,
  active,
  disabled,
  compact,
  onClick,
}: {
  label: string;
  Icon?: ComponentType<{ className?: string }>;
  active: boolean;
  disabled?: boolean;
  compact?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        OPTION_BASE,
        'grid place-items-center gap-1 px-2',
        compact ? 'py-2' : 'py-2.5',
        active && OPTION_ACTIVE,
      )}
    >
      {Icon ? <Icon className="size-4" /> : null}
      <span className="truncate text-[11px] font-[650]">{label}</span>
    </button>
  );
}

/** Full-width action styled as a panel control rather than a form button. */
export function PanelButton({
  children,
  Icon,
  active,
  disabled,
  tone = 'neutral',
  onClick,
  onMouseEnter,
  onMouseLeave,
}: {
  children: ReactNode;
  Icon?: ComponentType<{ className?: string }>;
  active?: boolean;
  disabled?: boolean;
  tone?: 'neutral' | 'accent';
  onClick: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={cn(
        OPTION_BASE,
        'flex w-full items-center justify-center gap-2 px-3 py-2.5 text-[12px] font-[700]',
        tone === 'accent' && 'border-[#5eead4]/25 text-[#ccfbf1]/80',
        active && OPTION_ACTIVE,
      )}
    >
      {Icon ? <Icon className="size-4" /> : null}
      {children}
    </button>
  );
}

/**
 * A named capability with a one-line explanation and a single action.
 * Used for the generated/automated features that used to be glowing gradient
 * cards competing with each other for attention.
 */
export function ActionCard({
  Icon,
  title,
  description,
  actionLabel,
  disabled,
  onAction,
}: {
  Icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  actionLabel: string;
  disabled?: boolean;
  onAction: () => void;
}) {
  return (
    <div className="space-y-2.5 rounded-[16px] border border-white/[0.07] bg-white/[0.025] p-3">
      <div className="flex items-center gap-2.5">
        <span className="grid size-7 flex-none place-items-center rounded-[10px] bg-emerald-400/12 text-[#5eead4]">
          <Icon className="size-4" />
        </span>
        <span className="text-[13px] font-[700] text-white/90">{title}</span>
      </div>

      <p className="text-[11px] leading-relaxed text-white/40">{description}</p>

      <PanelButton disabled={disabled} tone="accent" onClick={onAction}>
        {actionLabel}
      </PanelButton>
    </div>
  );
}

/** Shown when a panel needs a selection it does not have. */
export function PanelEmpty({
  Icon,
  title,
  hint,
}: {
  Icon: ComponentType<{ className?: string }>;
  title: string;
  hint?: string;
}) {
  return (
    <div className="grid place-items-center gap-2 rounded-[16px] border border-dashed border-white/12 px-4 py-8 text-center">
      <Icon className="size-5 text-white/25" />
      <span className="text-[13px] font-[650] text-white/55">{title}</span>
      {hint ? <p className="max-w-[220px] text-[11px] leading-snug text-white/30">{hint}</p> : null}
    </div>
  );
}

/** Quiet explanatory text between controls. */
export function PanelNote({ children }: { children: ReactNode }) {
  return <p className="text-[11px] leading-snug text-white/35">{children}</p>;
}
