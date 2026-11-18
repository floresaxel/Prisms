/**
 * The "this timer is live" mark: a solid circle that dips and swells, shedding one
 * ring as it swells back. Used by My Day's run banner (in the running task's project
 * colour) and by the topbar timer pill (white, on the pill's blue, pulse only — no
 * ring, which would crowd the pill; pass `wave={false}`). Styles are
 * `.px-run-*` in theme.css; `--white` is for sitting on a blue ground.
 */
import type { DotTone } from '../format';

export function RunMark({ tone, size, testId, wave = true }: { tone: DotTone | 'white'; size?: number; testId?: string; wave?: boolean }) {
  const toneClass = tone === 'white' ? 'px-run-mark--white' : `px-pdot--${tone}`;
  return (
    <span
      className={`px-run-mark${tone === 'white' ? ' px-run-mark--white' : ''}`}
      style={size ? { width: size, height: size } : undefined}
      data-testid={testId}
      aria-hidden="true"
    >
      {wave && <span className={`px-run-wave ${toneClass}`} />}
      <span className={`px-run-core ${toneClass}`} data-testid={testId ? `${testId}-core` : undefined} />
    </span>
  );
}
