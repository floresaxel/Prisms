/**
 * A project dropdown whose project names are bubbles styled like the
 * Journal's tags (blue pill, no #). The closed control shows the chosen project
 * as one bubble; opened,
 * every project/milestone is a bubble in a small popover. It stands in for the
 * native <select> (a native list can't style its options) on the Inbox rows, the
 * capture bar and the complete-capture dialog.
 *
 * With nothing chosen it reads `placeholder` in light grey, no bubble. `noneLabel`
 * adds a first, plain (non-bubble) choice that sets the value back to '' — the
 * capture bar's "Inbox — assign later". `variant="field"` boxes the control like
 * a text input, for forms.
 *
 * The popover is portalled to <body> and positioned from the trigger — the rows'
 * list clips whatever overflows it. It closes on Escape (without also closing a
 * dialog it sits in), a click elsewhere, a scroll or a resize. Clicks inside stay
 * off the row (they never open the card).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Ic, type PromoteTarget } from '@prisms/ui';

const POP_MAX_W = 380;

export function ProjectPicker({
  targets,
  value,
  onChange,
  testId,
  emptyLabel = 'No project to assign to',
  placeholder = 'Assign project',
  noneLabel,
  variant,
  ariaLabel,
  title,
}: {
  targets: PromoteTarget[];
  value: string;
  onChange: (id: string) => void;
  testId?: string;
  /** Shown (disabled) when there is no project at all — unless `noneLabel` gives a choice anyway. */
  emptyLabel?: string;
  /** Shown in light grey while nothing is chosen. */
  placeholder?: string;
  /** A first, plain choice that clears the value ('' — e.g. "Inbox — assign later"). */
  noneLabel?: string;
  variant?: 'field';
  ariaLabel?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const current = targets.find((t) => t.id === value) ?? null;
  const disabled = targets.length === 0 && noneLabel === undefined;

  function pick(id: string) {
    onChange(id);
    setOpen(false);
    trigger.current?.focus();
  }

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 240), POP_MAX_W, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setPos({ left, top: r.bottom + 4, width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as globalThis.Node;
      if (trigger.current?.contains(t) || pop.current?.contains(t)) return;
      setOpen(false);
    };
    // Capture phase on window, so this Escape closes only the popover: a Modal
    // around the picker listens on window too and would otherwise close as well.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    const shut = () => setOpen(false);
    document.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc, true);
    window.addEventListener('resize', shut);
    window.addEventListener('scroll', shut, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc, true);
      window.removeEventListener('resize', shut);
      window.removeEventListener('scroll', shut, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`px-ppick${variant === 'field' ? ' px-ppick--field' : ''}`}
        data-testid={testId}
        data-value={value}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        title={title ?? (current ? current.title : undefined)}
        onClick={() => setOpen((o) => !o)}
      >
        {current ? (
          <span className="px-ppick-tag">
            <span className="px-ppick-name">{current.title}</span>
            {current.type === 'milestone' && <span className="px-ppick-kind">milestone</span>}
          </span>
        ) : (
          <span className="px-ppick-empty">{disabled ? emptyLabel : placeholder}</span>
        )}
        <Ic name="chevd" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={pop}
            className="px-ppick-pop"
            role="listbox"
            aria-label="Project"
            style={{ left: pos.left, top: pos.top, width: pos.width }}
            onClick={(e) => e.stopPropagation()}
          >
            {noneLabel !== undefined && (
              <button
                type="button"
                role="option"
                aria-selected={value === ''}
                className={`px-ppick-none${value === '' ? ' px-ppick-none--on' : ''}`}
                data-testid={testId ? `${testId}-opt-none` : undefined}
                onClick={() => pick('')}
              >
                {noneLabel}
              </button>
            )}
            {targets.map((t) => (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={t.id === value}
                className={`px-ppick-opt${t.id === value ? ' px-ppick-opt--on' : ''}`}
                data-testid={testId ? `${testId}-opt-${t.id}` : undefined}
                onClick={() => pick(t.id)}
              >
                <span className="px-ppick-name">{t.title}</span>
                {t.type === 'milestone' && <span className="px-ppick-kind">milestone</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
