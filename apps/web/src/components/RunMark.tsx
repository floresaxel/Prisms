/**
 * The "this timer is live" mark: a solid circle that dips and swells, shedding one
 * ring as it swells back. Used by My Day's run banner (in the running task's project
 * colour) and by the topbar timer pill (white, on the pill's blue — `tone="white"`).
 * Both are the same size and shape and run the same animation; each mark starts its
 * animation part-way in, at the point the wall clock puts it, so every mark on screen
 * pulses in lockstep no matter when it mounted. Styles are `.px-run-*` in theme.css.
 */
import { useState, type CSSProperties } from 'react';

import type { DotTone } from '../format';

/** Must equal the 1.8 s animation duration of `.px-run-core` / `.px-run-wave` in theme.css. */
const RUN_PERIOD_MS = 1800;

export function RunMark({ tone, size, testId, wave = true }: { tone: DotTone | 'white'; size?: number; testId?: string; wave?: boolean }) {
  const toneClass = tone === 'white' ? 'px-run-mark--white' : `px-pdot--${tone}`;
  // a negative delay = "already this far into the loop": phase comes from the clock, not from mount time
  const [phase] = useState(() => -(Date.now() % RUN_PERIOD_MS));
  const style = { width: size, height: size, '--px-run-phase': `${phase}ms` } as CSSProperties;
  return (
    <span
      className={`px-run-mark${tone === 'white' ? ' px-run-mark--white' : ''}`}
      style={style}
      data-testid={testId}
      aria-hidden="true"
    >
      {wave && <span className={`px-run-wave ${toneClass}`} />}
      <span className={`px-run-core ${toneClass}`} data-testid={testId ? `${testId}-core` : undefined} />
    </span>
  );
}
