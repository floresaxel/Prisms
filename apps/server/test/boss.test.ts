/**
 * Job-registration guard (no DB): the §11 queue + cron wiring is data-driven in
 * boss.ts so it can be asserted without booting pg-boss. Pins that
 * review.expire is actually scheduled weekly (S5-F1 — it was previously built,
 * tested, and never wired) and that every scheduled queue is a known QUEUE.
 */
import { describe, expect, it } from 'vitest';

import { QUEUES, SCHEDULES } from '../src/jobs/boss';

describe('job scheduling registration', () => {
  it('review.expire is scheduled weekly (S5-F1)', () => {
    const s = SCHEDULES.find((x) => x.queue === QUEUES.reviewExpire);
    expect(s?.cron).toBe('0 4 * * 0');
  });

  it('retention.purge is scheduled weekly (companion to review.expire)', () => {
    const s = SCHEDULES.find((x) => x.queue === QUEUES.retentionPurge);
    expect(s?.cron).toBe('0 3 * * 0');
  });

  it('every scheduled queue is a registered QUEUE constant', () => {
    const known = new Set(Object.values(QUEUES));
    for (const s of SCHEDULES) expect(known.has(s.queue as (typeof QUEUES)[keyof typeof QUEUES])).toBe(true);
  });

  it('no queue is scheduled twice', () => {
    const seen = new Set<string>();
    for (const s of SCHEDULES) {
      expect(seen.has(s.queue)).toBe(false);
      seen.add(s.queue);
    }
  });
});
