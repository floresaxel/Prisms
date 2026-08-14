/**
 * The topbar's sync chip.
 *
 * Connection state is not sync state: a connected client with a queue behind it
 * is mid-sync. The chip reports the QUEUE — "synced" means nothing of yours is
 * still waiting to reach the server.
 *
 * The whole point of the choreography here is that the chip must not shuffle the
 * topbar when its wording changes. It sits in a slot wide enough for its longest
 * status, so nothing outside it ever moves; inside that slot it is left-aligned
 * and hugs its own text, growing rightwards into the reserved gap and shrinking
 * back. The dot therefore never moves either — it is at the fixed left edge.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import { useSyncQueue } from '@prisms/ui';

/**
 * How long the WORDS lag behind the state. The dot recolours at once — it is the
 * status, and delaying it would make the chip briefly lie — while the text waits
 * for the box to have started opening, so the room appears before the words that
 * need it. Shrinking runs the other way round (see `boxWidth`).
 */
const TEXT_DELAY_MS = 100;

type SyncState = 'connecting' | 'syncing' | 'synced';
const LABELS: Record<SyncState, string> = {
  connecting: 'connecting…',
  syncing: 'syncing…',
  synced: 'synced',
};

/**
 * Text width WITHOUT touching the DOM. A hidden element would have worked too,
 * but its text would join the chip's `textContent` — which an e2e reads to wait
 * for the queue to drain — and a screen reader's. Canvas metrics belong to no
 * node. Returns 0 where there is no canvas (jsdom), and callers fall back to an
 * unset width, i.e. the natural one.
 */
let measureCtx: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, font: string): number {
  if (measureCtx === undefined) {
    // jsdom has no 2d context and complains loudly about being asked; the chip
    // works without measurement, so ask once and never again.
    try {
      measureCtx = document.createElement('canvas').getContext('2d');
    } catch {
      measureCtx = null;
    }
  }
  if (!measureCtx || !font) return 0;
  measureCtx.font = font;
  return Math.ceil(measureCtx.measureText(text).width);
}

export function SyncChip({ connected }: { connected: boolean }) {
  const { busy, pending } = useSyncQueue();
  const state: SyncState = !connected ? 'connecting' : busy ? 'syncing' : 'synced';
  const label = LABELS[state];

  // The words trail the state by TEXT_DELAY_MS; the state itself (and so the dot)
  // is applied immediately.
  const [shown, setShown] = useState(label);
  useEffect(() => {
    if (shown === label) return;
    const t = setTimeout(() => setShown(label), TEXT_DELAY_MS);
    return () => clearTimeout(t);
  }, [label, shown]);

  const chipRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [reserve, setReserve] = useState<number | null>(null);

  useLayoutEffect(() => {
    const chip = chipRef.current;
    const lab = labelRef.current;
    if (!chip || !lab) return;
    const font = getComputedStyle(lab).font;
    const measured: Record<string, number> = {};
    for (const l of Object.values(LABELS)) measured[l] = textWidth(l, font);
    const widest = Math.max(0, ...Object.values(measured));
    if (widest === 0) return; // no canvas (jsdom): leave everything at natural width
    setWidths(measured);
    // The slot has to reserve the chip's widest BORDER box, not just its text.
    // Deriving the chrome by subtraction keeps padding/border/dot/gap out of this
    // file — change them in the stylesheet and the reservation still follows.
    const chrome = chip.getBoundingClientRect().width - lab.getBoundingClientRect().width;
    setReserve(Math.ceil(widest + chrome));
  }, []);

  /**
   * Growing happens NOW, shrinking waits for the words.
   *
   * While the text is still catching up the box takes whichever of the two is
   * wider: on the way up that opens the room before the longer word lands, and
   * on the way down it holds the old width until the shorter word is in, so the
   * text is never clipped by a box shrinking out from under it.
   */
  const boxWidth = widths[label] === undefined ? undefined : Math.max(widths[label]!, widths[shown] ?? 0);

  return (
    <div
      className="px-sync-slot"
      style={reserve === null ? undefined : ({ '--px-sync-reserve': `${reserve}px` } as CSSProperties)}
    >
      <div
        ref={chipRef}
        className={`px-sync-chip${state === 'connecting' ? ' px-sync-chip--connecting' : state === 'syncing' ? ' px-sync-chip--syncing' : ''}`}
        data-testid="sync-state"
        data-sync={state}
        title={pending > 0 ? `${pending} change(s) not yet on the server` : undefined}
      >
        <span className="px-dot" />
        <span ref={labelRef} className="px-sync-label" style={boxWidth === undefined ? undefined : { width: boxWidth }}>
          {shown}
        </span>
      </div>
    </div>
  );
}
