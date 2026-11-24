/**
 * Growing down — shared by the day's note (RichJournalEditor) and the task card's
 * Details (MarkdownField).
 *
 * A new line lands at the bottom of a field, and the field's box follows it DOWN:
 * its height eases from where it was to where the text now needs it, clipping the
 * new line until the edge has slid past it. Nothing above moves.
 *
 * And when the caret has to be brought into view, the scroller GLIDES there
 * rather than snapping a line at a time (`followCaret`).
 */
import { useEffect, useRef } from 'react';

import type { Editor } from '@tiptap/react';

/** How long the box takes to reach a new line. Short: it runs on every Enter. */
const GROW_MS = 160;
const GROW_EASE = 'cubic-bezier(0.2, 0, 0, 1)';
/** On the box for the length of a slide — see `.px-ed-growing` in theme.css. */
const GROWING = 'px-ed-growing';

const reducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The box's settled height, and the animation easing it there if one is running. */
export interface Grow {
  el: HTMLElement | null;
  last: number;
  anim: Animation | null;
  ro: ResizeObserver | null;
}

/** One `Grow` per editor, released (observer and animation) on unmount. */
export function useGrow(): Grow {
  const grow = useRef<Grow>({ el: null, last: 0, anim: null, ro: null });
  useEffect(() => {
    const s = grow.current;
    return () => {
      s.ro?.disconnect();
      s.anim?.cancel();
    };
  }, []);
  return grow.current;
}

/**
 * Start following `el`, the box that should slide. A ResizeObserver keeps `last`
 * current through every change that is NOT typing — a synced edit landing, the
 * window resizing — so the next keystroke animates from the height actually on
 * screen. It stands down while an animation runs: those are the animation's own
 * frames. A no-op for the element already followed.
 */
export function track(s: Grow, el: HTMLElement | null): void {
  if (!el || s.el === el || typeof ResizeObserver !== 'function') return;
  s.ro?.disconnect();
  s.el = el;
  s.last = el.getBoundingClientRect().height;
  s.ro = new ResizeObserver(() => {
    if (!s.anim && s.el) s.last = s.el.getBoundingClientRect().height;
  });
  s.ro.observe(el);
}

/**
 * Called right after an edit reached the DOM — the box is already at its NEW
 * height, and `last` still holds the old one. Animate between the two. An edit
 * landing mid-animation starts from wherever the edge has got to, so fast typing
 * is one continuous slide rather than a stutter. A box that cannot grow (held at
 * a cap, scrolling inside) keeps its height, so nothing animates.
 */
export function growDown(s: Grow): void {
  const el = s.el;
  if (!el || typeof el.animate !== 'function') return;
  const from = s.anim ? el.getBoundingClientRect().height : s.last;
  s.anim?.cancel();
  s.anim = null;
  const to = el.getBoundingClientRect().height;
  s.last = to;
  if (Math.abs(to - from) < 0.5 || reducedMotion()) {
    el.classList.remove(GROWING);
    return;
  }
  el.classList.add(GROWING);
  const a = el.animate({ height: [`${from}px`, `${to}px`] }, { duration: GROW_MS, easing: GROW_EASE });
  s.anim = a;
  a.onfinish = () => {
    if (s.anim !== a) return;
    s.anim = null;
    el.classList.remove(GROWING);
  };
}

/**
 * The nearest element that actually scrolls `el` — the page (`.px-content`) for
 * the day's note, the Details box itself once it is capped in the task card. One
 * that has nothing to scroll is passed over.
 */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Room kept between the caret and the scroller's edge. */
const CARET_MARGIN = 24;

/**
 * Keep the caret in view by GLIDING its scroller, not snapping it. ProseMirror's
 * own scroll jumps a line at a time, and it runs before the box has grown — so at
 * the bottom of the window every Enter yanked the whole page up a line while the
 * box's edge was still sliding down. Use as `editorProps.handleScrollToSelection`;
 * returns false (ProseMirror's default) when there is nothing to scroll.
 */
export function followCaret(view: Editor['view']): boolean {
  const scroller = scrollParent(view.dom);
  if (!scroller) return false;
  let caret: { top: number; bottom: number };
  try {
    caret = view.coordsAtPos(view.state.selection.head);
  } catch {
    return false;
  }
  const box = scroller.getBoundingClientRect();
  // a small box (the capped Details field) gets a margin it can afford
  const margin = Math.min(CARET_MARGIN, box.height / 4);
  let delta = 0;
  if (caret.bottom > box.bottom - margin) delta = caret.bottom - (box.bottom - margin);
  else if (caret.top < box.top + margin) delta = caret.top - (box.top + margin);
  if (delta !== 0) scroller.scrollBy({ top: delta, behavior: reducedMotion() ? 'auto' : 'smooth' });
  return true;
}
