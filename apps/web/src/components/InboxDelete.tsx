/**
 * The × on an Inbox row: a quiet grey glyph (no bubble) that, once clicked, asks
 * "Delete?" in a small popover right beside it before anything is removed.
 * Escape, a click elsewhere, or "Keep" closes it. The popover sits inside the
 * row (the list clips what overflows it), opening toward the row's own content.
 */
import { useEffect, useRef, useState } from 'react';

import { Ic } from '@prisms/ui';

export function InboxDelete({ title, testId, onDelete }: { title: string; testId?: string; onDelete: () => void }) {
  const [asking, setAsking] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!asking) return;
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as globalThis.Node)) setAsking(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAsking(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [asking]);

  return (
    <span className="px-xdel" ref={box}>
      <button
        type="button"
        className="px-xbtn"
        aria-label="delete"
        aria-expanded={asking}
        title={`Delete “${title}”`}
        data-testid={testId}
        onClick={() => setAsking((a) => !a)}
      >
        <Ic name="x" />
      </button>
      {asking && (
        <span className="px-xpop" role="group" aria-label="Confirm delete" data-testid="inbox-delete-confirm">
          <span className="px-xpop-q">Delete?</span>
          <button type="button" className="px-btn px-btn--sm px-btn--danger" data-testid="inbox-delete-yes" onClick={() => { setAsking(false); onDelete(); }}>Delete</button>
          <button type="button" className="px-btn px-btn--sm" onClick={() => setAsking(false)}>Keep</button>
        </span>
      )}
    </span>
  );
}
