/**
 * Rows leave a list with an animation instead of vanishing.
 *
 * React removes a row's DOM node the moment its item is gone (checked off,
 * deleted, moved to another project, cleared from Review…), and every list in
 * the app would need its own exit bookkeeping to keep it around. Instead ONE
 * observer watches the page area: when a list row (`li.px-trow`, or the steps
 * panel under one) is taken out of a list that is still on the page, a copy of
 * it — a "ghost" — goes back in its place and collapses: it fades and its
 * height closes to nothing, so the rows below slide up rather than jump. Then
 * the ghost is removed.
 *
 * The ghost is inert and aria-hidden, and carries no `data-testid` or `id`, so
 * nothing can click it, read it out, or find it in place of the real row.
 *
 * Not a removal, so no ghost:
 *  - a row React MOVED (it is back in the document by the time we look);
 *  - a row replaced by a new node for the same item (same `data-testid` is
 *    still in the list);
 *  - a whole list or screen going away (its rows go with it; the list itself
 *    is the removed node, not a row);
 *  - reduced motion, or a browser without the Web Animations API (tests).
 */

/** How long a leaving row takes to fade and close. */
export const ROW_EXIT_MS = 240;

const ROW_SELECTOR = 'li.px-trow:not(.px-muted), li.px-sub-wrap';
const GHOST_CLASS = 'px-row-ghost';

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A copy of `row` that looks like it and does nothing. */
function ghostOf(row: HTMLElement): HTMLElement {
  const ghost = row.cloneNode(true) as HTMLElement;
  for (const el of [ghost, ...ghost.querySelectorAll<HTMLElement>('[data-testid], [id]')]) {
    el.removeAttribute('data-testid');
    el.removeAttribute('id');
  }
  // cloneNode copies attributes, not live state: carry over what an input shows
  const from = row.querySelectorAll('input, textarea, select');
  const to = ghost.querySelectorAll('input, textarea, select');
  from.forEach((src, i) => {
    const dst = to[i];
    if (src instanceof HTMLInputElement && dst instanceof HTMLInputElement) {
      dst.checked = src.checked;
      dst.value = src.value;
    } else if ((src instanceof HTMLTextAreaElement || src instanceof HTMLSelectElement) && dst) {
      (dst as HTMLTextAreaElement | HTMLSelectElement).value = src.value;
    }
  });
  ghost.classList.add(GHOST_CLASS);
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('inert', '');
  return ghost;
}

/** Put `ghost` where the row was: before its old next sibling, else after its old previous one. */
function insertAt(list: Node, ghost: HTMLElement, prev: Node | null, next: Node | null): void {
  if (next && next.parentNode === list) list.insertBefore(ghost, next);
  else if (prev && prev.parentNode === list) list.insertBefore(ghost, prev.nextSibling);
  else list.appendChild(ghost);
}

function collapse(ghost: HTMLElement): void {
  const h = ghost.getBoundingClientRect().height;
  const cs = getComputedStyle(ghost);
  const anim = ghost.animate(
    [
      { height: `${h}px`, opacity: 1, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, marginTop: cs.marginTop, marginBottom: cs.marginBottom, borderBottomWidth: cs.borderBottomWidth },
      { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', borderBottomWidth: '0px' },
    ],
    { duration: ROW_EXIT_MS, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' },
  );
  const done = () => ghost.remove();
  anim.onfinish = done;
  anim.oncancel = done;
}

/** Watch `root` for list rows being removed and animate them out. Returns the stop function. */
export function watchRowExits(root: HTMLElement | null): () => void {
  if (!root || typeof MutationObserver === 'undefined' || typeof Element.prototype.animate !== 'function') return () => {};
  const observer = new MutationObserver((records) => {
    if (reducedMotion()) return;
    for (const rec of records) {
      const list = rec.target;
      if (!(list instanceof HTMLElement) || !list.isConnected) continue; // the whole list went away
      rec.removedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement) || node.isConnected) return; // moved, not removed
        if (!node.matches(ROW_SELECTOR) || node.classList.contains(GHOST_CLASS)) return;
        const testId = node.getAttribute('data-testid');
        if (testId && [...list.children].some((c) => c.getAttribute('data-testid') === testId)) return; // re-rendered in place
        const ghost = ghostOf(node);
        insertAt(list, ghost, rec.previousSibling, rec.nextSibling);
        collapse(ghost);
      });
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
