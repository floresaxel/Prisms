/**
 * Create-a-vision dialog — a full-screen, centered form over a blurred page.
 *
 * A vision is the root of everything below it, so this asks for more than a
 * name: a DESCRIPTION (what it actually means) and an expected TIMELINE, both
 * required. The timeline is deliberately dateless — a unit (months / years /
 * decades) and an amount, i.e. an order of magnitude rather than a deadline.
 * Each unit offers quick-pick amounts (3/6/9 months, 1/3/5/8 years, 1/2/3/4
 * decades) and the amount field is also free text with a 1–10 dropdown, so a
 * value that is not a preset is one keystroke away.
 *
 * The colour is picked from a 20-swatch palette and must be UNIQUE: swatches
 * other visions already wear are struck through and disabled, and the form opens
 * on the first free one.
 *
 * The colour and timeline controls themselves live in VisionFields, shared with
 * the Vision screen's editor — creating and later correcting a vision ask for
 * the same things in the same shape.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  firstFreeVisionColor,
  Modal,
  visionColorOf,
  HORIZON_MAX,
  HORIZON_MIN,
  HORIZON_PRESETS,
  type HorizonUnit,
  type VisionColor,
  type VisionHorizon,
} from '@prisms/ui';

import { ColorField, colorLabel, HorizonField, parseHorizon } from './VisionFields';

export interface NewVisionValues {
  title: string;
  description: string;
  color: VisionColor;
  horizon: VisionHorizon;
}

export function NewVisionDialog({
  open,
  onClose,
  onCreate,
  /** Visions that already exist — their colours are taken. */
  existing,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (values: NewVisionValues) => void;
  existing: readonly { id: string; attributes?: Record<string, unknown> }[];
  busy?: boolean;
}) {
  const taken = useMemo(() => new Set(existing.map((v) => visionColorOf(v))), [existing]);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState<VisionColor>(() => firstFreeVisionColor(taken));
  const [unit, setUnit] = useState<HorizonUnit>('years');
  // kept as TEXT: the field is free-entry with a 1–10 dropdown, so a half-typed
  // or invalid value has to survive in the box long enough to be corrected.
  const [amount, setAmount] = useState('1');
  const [touched, setTouched] = useState(false);

  // Re-arm on each open: fresh form, and default to a colour that is still free.
  // ONLY on open — `taken` is derived from the live node tree, so it takes a new
  // identity on every sync tick, and depending on it here wiped a half-filled
  // form under the user's hands. The ref keeps the colour default current
  // without making the effect reactive to it.
  const takenRef = useRef(taken);
  takenRef.current = taken;
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setColor(firstFreeVisionColor(takenRef.current));
    setUnit('years');
    setAmount('1');
    setTouched(false);
  }, [open]);

  const horizon: VisionHorizon | null = parseHorizon(unit, amount);
  const amountOk = horizon !== null;
  const titleOk = title.trim() !== '';
  const descriptionOk = description.trim() !== '';
  const valid = titleOk && descriptionOk && horizon !== null;

  function submit() {
    setTouched(true);
    if (!valid || busy || !horizon) return;
    onCreate({ title: title.trim(), description: description.trim(), color, horizon });
  }

  const missing = !touched
    ? null
    : !titleOk
      ? 'Give the vision a name.'
      : !descriptionOk
        ? 'Add a description — what does this vision actually mean?'
        : !amountOk
          ? `The timeline needs a whole number between ${HORIZON_MIN} and ${HORIZON_MAX}.`
          : null;

  return (
    <Modal
      open={open}
      size="full"
      title="New vision"
      subtitle="A vision is the root everything else hangs from. Say what it means and roughly how long it runs — no dates, just the scale."
      onClose={onClose}
      actions={
        <>
          <button className="px-btn" data-testid="vision-dialog-cancel" onClick={onClose}>Cancel</button>
          <button
            className="px-btn px-btn--primary"
            data-testid="vision-dialog-create"
            disabled={busy || !valid}
            onClick={submit}
          >
            Create vision
          </button>
        </>
      }
    >
      <div className="px-vd-field">
        <label className="px-vd-lbl" htmlFor="vd-title">Name</label>
        <input
          id="vd-title"
          className="px-vd-input"
          data-testid="vision-dialog-title"
          placeholder="e.g. Build a company"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="px-vd-field">
        <label className="px-vd-lbl" htmlFor="vd-desc">Description</label>
        <textarea
          id="vd-desc"
          className="px-vd-input"
          data-testid="vision-dialog-description"
          placeholder="What does this vision mean, and how will you know you are living it?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="px-vd-field">
        <span className="px-vd-lbl">Expected timeline</span>
        <HorizonField
          unit={unit}
          amount={amount}
          testPrefix="vision-dialog"
          onChange={(u, a) => {
            setUnit(u);
            setAmount(a);
          }}
        />
        <p className="px-vd-hint">
          No dates — a vision runs on the order of {HORIZON_PRESETS.months.join('/')} months,{' '}
          {HORIZON_PRESETS.years.join('/')} years or {HORIZON_PRESETS.decades.join('/')} decades. Pick one, or type any
          number from {HORIZON_MIN} to {HORIZON_MAX}.
        </p>
      </div>

      <div className="px-vd-field">
        <span className="px-vd-lbl">
          Colour · <span className="px-swatch-name" data-testid="vision-dialog-color">{colorLabel(color)}</span>
        </span>
        <ColorField value={color} taken={taken} onChange={setColor} testPrefix="vision-dialog" />
        <p className="px-vd-hint">
          Every vision gets its own colour, and all of its roadmaps carry it. Struck-through swatches are taken.
        </p>
      </div>

      {missing && <p className="px-vd-err" data-testid="vision-dialog-error">{missing}</p>}
    </Modal>
  );
}
