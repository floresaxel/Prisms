/** Small display formatters (a UI concern — core stays free of locale/format). */

/** Elapsed milliseconds → `h:mm:ss` (or `m:ss` under an hour). */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** A machine-readable command rejection code → a human, actionable message (§7.13, M9). */
export function rejectionMessage(code: string | undefined): string {
  switch (code) {
    case 'E_STALE_SUGGESTION':
      return 'That suggestion was superseded by a newer plan and could not be accepted.';
    case 'E_SUGGESTION_OVERLAPS_ANCHOR':
      return 'That suggestion overlaps a locked block, so it could not be accepted.';
    case 'E_BLOCKED_TASK':
      return 'That task is blocked — use “Force clock in” to override the blocker.';
    case 'E_CLIENT_TOO_OLD':
      return 'This app version is too old to sync that change. Please update Prisms.';
    case 'E_DEPENDENCY_REJECTED':
      return 'A change this one depended on was rejected, so this was rolled back.';
    case 'E_DONE_IMMUTABLE':
      return 'That task is already done, so the change was rolled back.';
    default:
      return `Change rejected${code ? ` (${code})` : ''} and reverted.`;
  }
}

/** Stable per-project accent (the mock tints each project) derived from its id. */
const DOT_TONES = ['teal', 'blue', 'amber', 'green'] as const;
export type DotTone = (typeof DOT_TONES)[number];
export function projectTone(projectId: string | null): DotTone {
  if (!projectId) return 'blue';
  let h = 0;
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
  return DOT_TONES[h % DOT_TONES.length]!;
}

/** A signed minute count → human duration, e.g. `1h 30m`, `45m`, `−20m` (over). */
export function formatMinutes(min: number): string {
  const sign = min < 0 ? '−' : '';
  const abs = Math.round(Math.abs(min));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h > 0) return `${sign}${h}h ${m}m`;
  return `${sign}${m}m`;
}
