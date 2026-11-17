import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * An element's own width, observed — for screens that reflow with the room they
 * actually have. Measured rather than read off the viewport because the sidebar's
 * rail toggle changes the room available without the window resizing at all.
 *
 * 0 means "not measured yet" (first paint, or an environment with no layout such
 * as jsdom); callers treat it as the roomy layout so the common case never flashes
 * the narrow one.
 */
export function useMeasuredWidth(): [RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    // The one-shot measurement above is enough to render; only the LIVE reflow
    // needs an observer, so an environment without one (jsdom) still works.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w != null) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
