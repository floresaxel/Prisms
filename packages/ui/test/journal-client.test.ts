/**
 * J3 — pure client pieces: the optimistic journal effects (D3), the row mapper,
 * and the ref-counted month-subscription manager (mock StreamSubscriber).
 */
import { describe, expect, it } from 'vitest';

import { buildOptimisticEffects, createJournalMonthSubscriptions, type StreamSubscriber } from '../src/index';
import { toJournalEntry } from '../src/powersync/rows';

const D6_CORPUS = ['👍🏽', '👨‍👩‍👧‍👦', '🇫🇷', '❤️', 'café', 'שלום 🌍 hello'];
const CTX = { userId: 'u1', deviceId: 'web-1', now: '2026-06-27T00:00:00.000Z' };

describe('journal optimistic effects (D3, purity)', () => {
  it('journal.write → one ins on journal_entries with server-matching derived month_key (D6 verbatim)', () => {
    for (const content of D6_CORPUS) {
      const effs = buildOptimisticEffects('journal.write', { id: 'j1', entry_date: '2026-06-11', content }, CTX);
      expect(effs).toHaveLength(1);
      expect(effs[0]).toMatchObject({ table: 'journal_entries', row_id: 'j1', op: 'insert' });
      expect(effs[0]!.fields).toMatchObject({ id: 'j1', entry_date: '2026-06-11', month_key: '2026-06', content });
    }
  });

  it('journal.delete → a del on journal_entries', () => {
    expect(buildOptimisticEffects('journal.delete', { id: 'j1' }, CTX)).toEqual([
      { table: 'journal_entries', row_id: 'j1', op: 'delete', fields: {} },
    ]);
  });
});

describe('toJournalEntry mapper', () => {
  it('maps a loose row → JournalEntry, content verbatim (D6)', () => {
    const e = toJournalEntry({
      id: 'j1', user_id: 'u1', entry_date: '2026-06-11', month_key: '2026-06',
      content: D6_CORPUS[1], created_at: 't1', updated_at: 't1', deleted_at: null,
    });
    expect(e).toMatchObject({ id: 'j1', user_id: 'u1', entry_date: '2026-06-11', month_key: '2026-06', content: D6_CORPUS[1], deleted_at: null });
  });
});

/** A mock StreamSubscriber recording subscribe params + unsubscribes. */
function mockSubscriber() {
  const subscribes: unknown[] = [];
  const unsubscribes: unknown[] = [];
  const subscriber: StreamSubscriber = {
    syncStream(name, params) {
      expect(name).toBe('journal_month');
      return {
        subscribe: async () => {
          subscribes.push(params?.['month']);
          return { waitForFirstSync: async () => undefined, unsubscribe: () => unsubscribes.push(params?.['month']) };
        },
      };
    },
  };
  return { subscriber, subscribes, unsubscribes };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('JournalMonthSubscriptions (D3): ref-counted, { month } passthrough', () => {
  it('subscribes ONCE per month; unsubscribes only on the last release', async () => {
    const m = mockSubscriber();
    const mgr = createJournalMonthSubscriptions(m.subscriber);
    const r1 = mgr.hold('2026-06');
    const r2 = mgr.hold('2026-06'); // second holder → still one subscribe
    expect(m.subscribes).toEqual(['2026-06']); // param passthrough
    expect(mgr.heldMonths()).toEqual(['2026-06']);
    r1();
    expect(mgr.heldMonths()).toEqual(['2026-06']); // one holder left
    r2();
    expect(mgr.heldMonths()).toEqual([]); // last release drops it
    await flush();
    expect(m.unsubscribes).toEqual(['2026-06']);
    r2(); // idempotent double-release — no throw, no extra unsubscribe
    expect(m.unsubscribes).toEqual(['2026-06']);
  });

  it('distinct months are independent; re-hold after release re-subscribes', async () => {
    const m = mockSubscriber();
    const mgr = createJournalMonthSubscriptions(m.subscriber);
    const a = mgr.hold('2026-06');
    mgr.hold('2026-07');
    expect(new Set(mgr.heldMonths())).toEqual(new Set(['2026-06', '2026-07']));
    a();
    await flush();
    expect(mgr.heldMonths()).toEqual(['2026-07']);
    mgr.hold('2026-06'); // re-hold (before TTL) → a fresh subscribe
    expect(m.subscribes).toEqual(['2026-06', '2026-07', '2026-06']);
  });
});
