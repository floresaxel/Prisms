/**
 * Content that grows open and folds shut instead of popping in and out — the same
 * 0fr → 1fr grid collapse the journal's tag row and toolbar use (`.px-unfold`
 * in theme.css: 194 ms, eased, with a fade; none under reduced motion).
 *
 * The children stay MOUNTED while folded (so the fold can animate, and any state
 * inside survives), but a folded `Unfold` is `visibility: hidden` after the fold
 * finishes — out of the tab order, the accessibility tree and hit-testing.
 */
import type { ReactNode } from 'react';

export function Unfold({ open, children, testId }: { open: boolean; children: ReactNode; testId?: string }) {
  return (
    <div className={`px-unfold${open ? ' px-unfold--open' : ''}`} data-testid={testId} data-open={open}>
      <div>{children}</div>
    </div>
  );
}
