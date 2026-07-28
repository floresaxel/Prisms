/**
 * SEC-6/F9: per-user isolation for the all-users cron entry points.
 *
 * `weather.poll`, `aggregates.recompute`, `pastdue.scan` and `schedule.optimize`
 * each ran `for (const u of users) await runX(u)` with no error handling, so the
 * FIRST user to throw aborted the cycle and every user after them was silently
 * skipped — for that run and, since these are cron jobs, potentially forever if
 * the cause was a persistent data condition. On a shared self-hosted node that
 * turns one user's bad row (or one upstream weather blip) into everyone's
 * outage.
 *
 * A batch job over independent per-user work should degrade per user, not per
 * batch: log the failure, keep going, and report what actually happened.
 */

export interface BatchOutcome {
  /** Users considered. */
  total: number;
  /** Users whose work completed. */
  succeeded: number;
  /** Users whose work threw (each logged, none fatal). */
  failed: number;
}

/**
 * Run `work` for every item, isolating failures.
 *
 * Deliberately sequential, matching the previous behaviour: these jobs each hold
 * a transaction and read whole-table snapshots, so running them concurrently
 * would trade one problem for a worse one on a small node.
 */
export async function forEachUserIsolated<T>(
  items: readonly T[],
  jobName: string,
  userIdOf: (item: T) => string,
  work: (item: T) => Promise<unknown>,
  log: (line: string) => void = console.error,
): Promise<BatchOutcome> {
  let succeeded = 0;
  let failed = 0;
  for (const item of items) {
    try {
      await work(item);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      log(
        JSON.stringify({
          msg: 'job failed for one user; continuing',
          job: jobName,
          user_id: userIdOf(item),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  return { total: items.length, succeeded, failed };
}
