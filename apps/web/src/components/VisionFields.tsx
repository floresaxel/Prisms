/**
 * The two fields that make a vision individual — its COLOUR and its dateless
 * TIMELINE. Shared by the create dialog (NewVisionDialog) and the Vision
 * screen's editor, so a vision is described the same way whether it is being
 * created or corrected later.
 *
 * Both are presentational and fully CONTROLLED: the caller owns the state. The
 * horizon's amount stays TEXT in the caller on purpose — a half-typed or
 * out-of-range value has to survive in the box long enough to be corrected —
 * and `parseHorizon` turns (unit, text) into a horizon or null.
 */
import {
  formatHorizon,
  visionHex,
  isHorizonAmount,
  HORIZON_MAX,
  HORIZON_MIN,
  HORIZON_PRESETS,
  HORIZON_UNITS,
  VISION_PALETTE,
  type HorizonUnit,
  type VisionColor,
  type VisionHorizon,
} from '@prisms/ui';

const AMOUNT_OPTIONS = Array.from({ length: HORIZON_MAX - HORIZON_MIN + 1 }, (_, i) => HORIZON_MIN + i);

/** (unit, free-text amount) → a horizon, or null while the text is not a legal amount. */
export function parseHorizon(unit: HorizonUnit, amount: string): VisionHorizon | null {
  const parsed = Number(amount.trim());
  return amount.trim() !== '' && isHorizonAmount(parsed) ? { unit, amount: parsed } : null;
}

/**
 * Unit tabs + quick-pick amounts + a free-entry number, with a live preview.
 * Switching unit re-seeds the amount to that unit's first preset, so the value
 * is never left invalid by a unit change alone.
 */
export function HorizonField({
  unit,
  amount,
  onChange,
  /** Prefix for `data-testid`s — the dialog and the screen address their own. */
  testPrefix,
}: {
  unit: HorizonUnit;
  amount: string;
  onChange: (unit: HorizonUnit, amount: string) => void;
  testPrefix: string;
}) {
  const horizon = parseHorizon(unit, amount);
  const listId = `${testPrefix}-amounts`;

  return (
    <div className="px-vd-row">
      <div className="px-vd-units" role="tablist" aria-label="timeline unit">
        {HORIZON_UNITS.map((u) => (
          <button
            key={u}
            role="tab"
            aria-selected={u === unit}
            data-testid={`${testPrefix}-unit-${u}`}
            className={`px-vd-unit${u === unit ? ' px-vd-unit--on' : ''}`}
            onClick={() => onChange(u, String(HORIZON_PRESETS[u][0]))}
          >
            {u}
          </button>
        ))}
      </div>

      <div className="px-vd-presets">
        {HORIZON_PRESETS[unit].map((n) => (
          <button
            key={n}
            className={`px-vd-preset${horizon?.amount === n ? ' px-vd-preset--on' : ''}`}
            data-testid={`${testPrefix}-preset-${n}`}
            aria-pressed={horizon?.amount === n}
            onClick={() => onChange(unit, String(n))}
          >
            {n}
          </button>
        ))}
      </div>

      <span className="px-vd-sep">or</span>
      {/* free text + a 1–10 dropdown: `list` keeps the box fully typeable */}
      <input
        className="px-vd-amount"
        data-testid={`${testPrefix}-amount`}
        type="number"
        inputMode="numeric"
        min={HORIZON_MIN}
        max={HORIZON_MAX}
        list={listId}
        aria-label={`number of ${unit}`}
        value={amount}
        onChange={(e) => onChange(unit, e.target.value)}
      />
      <datalist id={listId}>
        {AMOUNT_OPTIONS.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      <span className="px-vd-preview" data-testid={`${testPrefix}-horizon`}>
        {horizon ? formatHorizon(horizon) : '—'}
      </span>
    </div>
  );
}

/**
 * The 20-swatch palette. A colour is UNIQUE per vision: swatches in `taken` are
 * struck through and disabled. Pass the vision's OWN colour outside `taken`
 * when editing, or it would be disabled on its own row.
 */
export function ColorField({
  value,
  taken,
  onChange,
  testPrefix,
}: {
  value: VisionColor;
  taken: ReadonlySet<VisionColor>;
  onChange: (color: VisionColor) => void;
  testPrefix: string;
}) {
  return (
    <div className="px-swatches" role="radiogroup" aria-label="vision colour">
      {VISION_PALETTE.map((c) => {
        const used = taken.has(c.id) && c.id !== value;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={c.id === value}
            aria-label={used ? `${c.label} (already used)` : c.label}
            title={used ? `${c.label} — already used by another vision` : c.label}
            disabled={used}
            data-testid={`${testPrefix}-swatch-${c.id}`}
            className={`px-swatch${c.id === value ? ' px-swatch--on' : ''}`}
            style={{ background: visionHex(c.id) }}
            onClick={() => onChange(c.id)}
          />
        );
      })}
    </div>
  );
}

/** The palette entry's human label ("Teal"), for the field heading. */
export function colorLabel(color: VisionColor): string {
  return VISION_PALETTE.find((c) => c.id === color)?.label ?? color;
}
