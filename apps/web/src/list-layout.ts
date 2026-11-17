/**
 * How the task-list screens (My Day, Tasks) arrange themselves at a given width —
 * a pure function so the rules are testable without a browser, like
 * `agenda-layout.ts`.
 *
 *  - `stacked`: My Day's right rail (292px + gap) moves BELOW the list instead of
 *    squeezing it. Below `STACK_W` the list column would be under ~590px, which is
 *    where its row (check · title · progress · due · button) stops fitting.
 *  - `compact`: the rows themselves reflow — the progress bar drops to its own
 *    line and buttons lose their text — once even the full width is tight.
 */

/** Narrower than this and the right rail goes under the list. */
export const STACK_W = 900;
/** Narrower than this and rows reflow onto two lines. */
export const COMPACT_W = 600;

export interface ListLayout {
  stacked: boolean;
  compact: boolean;
}

/** `width` is the screen's own measured width; 0 = not measured yet → roomy. */
export function listLayout(width: number): ListLayout {
  if (width <= 0) return { stacked: false, compact: false };
  return { stacked: width < STACK_W, compact: width < COMPACT_W };
}

/** The modifier classes for a screen's root element. */
export function listLayoutClass(width: number): string {
  const { stacked, compact } = listLayout(width);
  return `${stacked ? ' px-list--stack' : ''}${compact ? ' px-list--compact' : ''}`;
}
