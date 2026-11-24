/**
 * A range slider with a tick at every step: a little fill at the minimum, and the
 * fill runs the whole way to the right at its maximum.
 *
 * It is still a real `<input type="range">` (keyboard, screen readers, `fill()` in
 * tests) — only the picture is drawn here. The native one leaves the thumb inset
 * from the track's ends, so a full slider never looked full. The track is drawn
 * edge to edge instead, the ticks sit where the thumb's CENTRE lands at each step
 * (half a thumb in from each end), and at the maximum the thumb sits flush against
 * the right end with the fill running up to it. The fill leads the thumb a little
 * (a short stub past the dot at the minimum), so an empty slider is not a bare dot.
 *
 * `labels` prints a number under chosen steps (by index into the steps).
 */
import type { CSSProperties } from 'react';

export function StepSlider({
  min,
  max,
  step,
  value,
  onChange,
  testId,
  ariaLabel,
  labels,
  valueText,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  testId?: string;
  ariaLabel?: string;
  /** One caption per step, in order (length = steps + 1); empty strings leave a step bare. */
  labels?: readonly string[];
  /** What a screen reader says for the current value, when the raw number is not it (`aria-valuetext`). */
  valueText?: string;
}) {
  const steps = Math.max(1, Math.round((max - min) / step));
  const at = (i: number) => `${(i / steps) * 100}%`;
  const pct = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return (
    <div className="px-steps" style={{ '--px-steps-pct': pct } as CSSProperties}>
      <div className="px-steps-body">
        <span className="px-steps-rail" aria-hidden="true" />
        <span className="px-steps-ticks" aria-hidden="true">
          {Array.from({ length: steps + 1 }, (_, i) => (
            <i key={i} style={{ left: at(i) }} />
          ))}
        </span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          data-testid={testId}
          aria-label={ariaLabel}
          aria-valuetext={valueText}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
      {labels && (
        <span className="px-steps-labels" aria-hidden="true">
          {labels.map((text, i) => (text ? <span key={i} style={{ left: at(i) }}>{text}</span> : null))}
        </span>
      )}
    </div>
  );
}
