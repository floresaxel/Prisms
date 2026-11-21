/**
 * The "this timer is live" mark: a solid circle that dips and swells, shedding one
 * ring as it swells back. Used by My Day's run banner (in the running task's project
 * colour) and by the topbar timer pill (white, on the pill's blue, pulse only — no
 * ring, which would crowd the pill; pass `wave={false}`). Styles are
 * `.px-run-*` in theme.css; `--white` is for sitting on a blue ground.
 *
 * `color` (a hex) overrides the tone: the run banner passes the colour of the
 * running task's vision, the same colour its project's pentagon wears beside it.
 */
import type { DotTone } from '../format';

export function RunMark({ tone, color, size, testId, wave = true }: { tone: DotTone | 'white'; color?: string | null; size?: number; testId?: string; wave?: boolean }) {
  // the tone class stays (the fallback colour); an inline `color` simply paints over it
  const toneClass = tone === 'white' ? 'px-run-mark--white' : `px-pdot--${tone}`;
  const paint = tone !== 'white' && color ? { background: color } : undefined;
  return (
    <span
      className={`px-run-mark${tone === 'white' ? ' px-run-mark--white' : ''}`}
      style={size ? { width: size, height: size } : undefined}
      data-testid={testId}
      aria-hidden="true"
    >
      {wave && <span className={`px-run-wave ${toneClass}`} style={paint} />}
      <span className={`px-run-core ${toneClass}`} style={paint} data-testid={testId ? `${testId}-core` : undefined} />
    </span>
  );
}
