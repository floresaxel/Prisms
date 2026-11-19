/**
 * A project dropdown whose project names are bubbles, like tags. The closed
 * control shows the chosen project as one bubble (colour chip + name); opened,
 * every project/milestone is a bubble in a small popover. It is a drop-in for the
 * native <select> the Inbox rows used (a native list can't style its options).
 *
 * The popover is portalled to <body> and positioned from the trigger — the rows'
 * list clips whatever overflows it. It closes on Escape, a click elsewhere, a
 * scroll or a resize. Clicks inside stay off the row (they never open the card).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Ic, type PromoteTarget } from '@prisms/ui';

import { projectTone } from '../format';

const POP_MAX_W = 380;

export function ProjectPicker({
  targets,
  value,
  onChange,
  testId,
  emptyLabel = 'No project to assign to',
}: {
  targets: PromoteTarget[];
  value: string;
  onChange: (id: string) => void;
  testId?: string;
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const current = targets.find((t) => t.id === value) ?? null;

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
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    const shut = () => setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    window.addEventListener('resize', shut);
    window.addEventListener('scroll', shut, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('resize', shut);
      window.removeEventListener('scroll', shut, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="px-ppick"
        data-testid={testId}
        data-value={value}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={targets.length === 0}
        title={current ? current.title : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {current ? (
          <span className="px-tag px-tag--grey px-ppick-tag">
            <span className={`px-pdot px-pdot--${projectTone(current.id)}`} />
            <span className="px-ppick-name">{current.title}</span>
            {current.type === 'milestone' && <span className="px-ppick-kind">milestone</span>}
          </span>
        ) : (
          <span className="px-ppick-empty">{targets.length === 0 ? emptyLabel : 'Choose a project'}</span>
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
            {targets.map((t) => (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={t.id === value}
                className={`px-tag px-tag--grey px-ppick-opt${t.id === value ? ' px-ppick-opt--on' : ''}`}
                data-testid={testId ? `${testId}-opt-${t.id}` : undefined}
                onClick={() => {
                  onChange(t.id);
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                <span className={`px-pdot px-pdot--${projectTone(t.id)}`} />
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
