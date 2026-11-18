/**
 * Split focus (I5, up to MAX_OPEN_TIMERS running at once): while timers on N
 * different tasks overlap, each task is credited 1/N of that time. PURE (§16).
 *
 * The split is DERIVED at read time from the entries' own start/stop times — no
 * stored weight — so history never needs rewriting and an offline device that
 * learns about an overlapping entry later converges to the same numbers.
 *
 * `splitConcurrent` cuts every live entry at each moment the set of running
 * TASKS changes and tags each fragment with its `share` (1/N). Two entries on
 * the SAME task (an offline double clock-in) are one task, not two — their
 * overlap is still unioned once by `mergeTimeEntries`, which weights each
 * instant by the fragment's share. Fragments keep their entry's id and task_id.
 *
 * Aggregates call this on the user's FULL entry list and only then pick a task's
 * fragments: a task's share depends on what else was running.
 */
import type { TimeEntry } from '../domain/entities';
import { asEpochMillis, epochMillisToIso as toIso, isoToEpochMillis } from '../time/instant';

const epochMillisToIso = (ms: number) => toIso(asEpochMillis(ms));

export type SplitEntry = TimeEntry & { readonly share: number };

const cache = new WeakMap<readonly TimeEntry[], SplitEntry[]>();

/**
 * Closed, live entries cut into constant-share fragments. With `nowMs`, running
 * entries count as if they stopped now (for live displays); without it they are
 * left out, as every aggregate does with open entries (they are not facts yet).
 * The no-`nowMs` result is memoised per input array, so per-task callers in a
 * loop over the same list pay for the sweep once.
 */
export function splitConcurrent(entries: readonly TimeEntry[], nowMs?: number): SplitEntry[] {
  if (nowMs === undefined) {
    const hit = cache.get(entries);
    if (hit) return hit;
  }

  interface Iv { e: TimeEntry; s: number; t: number }
  const ivs: Iv[] = [];
  for (const e of entries) {
    if (e.deleted_at !== null) continue;
    const s = isoToEpochMillis(e.started_at);
    const t = e.ended_at !== null ? isoToEpochMillis(e.ended_at) : nowMs;
    if (t === undefined || t <= s) continue;
    ivs.push({ e, s, t });
  }

  const out: SplitEntry[] = [];
  const bounds = Array.from(new Set(ivs.flatMap((iv) => [iv.s, iv.t]))).sort((a, b) => a - b);
  // the open fragment per entry index, extended while its share holds
  const current = new Map<Iv, { start: number; end: number; share: number }>();
  const flush = (iv: Iv, frag: { start: number; end: number; share: number }) => {
    const whole = frag.start === iv.s && frag.end === iv.t;
    out.push({
      ...iv.e,
      // untouched when the entry was never split: byte-identical to before
      started_at: whole ? iv.e.started_at : epochMillisToIso(frag.start),
      ended_at: whole && iv.e.ended_at !== null ? iv.e.ended_at : epochMillisToIso(frag.end),
      share: frag.share,
    });
  };

  // sweep in boundary order; `ivs` sorted by start lets us admit them in turn
  const byStart = [...ivs].sort((a, b) => a.s - b.s);
  const active: Iv[] = [];
  let next = 0;
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const lo = bounds[i]!;
    const hi = bounds[i + 1]!;
    while (next < byStart.length && byStart[next]!.s <= lo) active.push(byStart[next++]!);
    for (let j = active.length - 1; j >= 0; j -= 1) {
      const iv = active[j]!;
      if (iv.t <= lo) {
        const frag = current.get(iv);
        if (frag) flush(iv, frag);
        current.delete(iv);
        active.splice(j, 1);
      }
    }
    if (active.length === 0) continue;
    const tasks = new Set(active.map((iv) => iv.e.task_id)).size;
    const share = 1 / tasks;
    for (const iv of active) {
      const frag = current.get(iv);
      if (frag && frag.share === share && frag.end === lo) frag.end = hi;
      else {
        if (frag) flush(iv, frag);
        current.set(iv, { start: lo, end: hi, share });
      }
    }
  }
  for (const [iv, frag] of current) flush(iv, frag);

  if (nowMs === undefined) cache.set(entries, out);
  return out;
}
