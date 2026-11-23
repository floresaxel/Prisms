/**
 * The focus-multiple field of a session's review item on the Review tab. It only
 * draws the field: a `×` and a text input that steps with ↑/↓ and the ▲/▼
 * buttons by a tenth, commits on Enter / blur, and drops a half-typed edit on
 * Escape. What a change DOES (here: it is kept until the item is cleared) is the
 * caller's.
 *
 * Testids: <prefix>-focus-<id>, <prefix>-up-<id>, <prefix>-down-<id>.
 */
import { Ic } from '@prisms/ui';

import { FOCUS_MAX, FOCUS_MIN, focusText } from '../focus-factor';

export function FocusStepper({
  prefix,
  id,
  label,
  draft,
  setDraft,
  shown,
  stored,
  onStep,
  onCommit,
}: {
  prefix: string;
  id: string;
  /** What the field is for, read out by screen readers ("Focus multiple for <task>"). */
  label: string;
  /** The text in the field. */
  draft: string;
  setDraft: (text: string) => void;
  /** The multiple the field currently stands for (the draft, or the stored one while the draft is junk). */
  shown: number;
  /** The multiple on record — Escape puts this back. */
  stored: number;
  onStep: (dir: 1 | -1) => void;
  onCommit: () => void;
}) {
  return (
    <span className="px-cl-focus">
      <span className="px-cl-x" aria-hidden="true">×</span>
      <input
        className="px-td-in px-cl-in"
        data-testid={`${prefix}-focus-${id}`}
        aria-label={label}
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            onStep(e.key === 'ArrowUp' ? 1 : -1);
          } else if (e.key === 'Escape' && draft !== focusText(stored)) {
            e.preventDefault();
            e.stopPropagation();
            setDraft(focusText(stored));
          }
        }}
      />
      <span className="px-td-spin">
        <button type="button" tabIndex={-1} aria-label="Raise the focus multiple by 0.1" data-testid={`${prefix}-up-${id}`} disabled={shown >= FOCUS_MAX} onClick={() => onStep(1)}>
          <Ic name="chevd" />
        </button>
        <button type="button" tabIndex={-1} aria-label="Lower the focus multiple by 0.1" data-testid={`${prefix}-down-${id}`} disabled={shown <= FOCUS_MIN} onClick={() => onStep(-1)}>
          <Ic name="chevd" />
        </button>
      </span>
    </span>
  );
}
