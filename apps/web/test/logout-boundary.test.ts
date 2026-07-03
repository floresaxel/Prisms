// @vitest-environment jsdom
/**
 * S9-F1 (+S8-F2) DoD: signing out ends the account's LOCAL presence, so a
 * subsequent login on a shared device (the supported multi-account flow) renders
 * NO rows from the previous account and cross-posts NONE of its queued commands.
 *
 * Two real mechanisms, exercised through the actual app code (no reimplementation):
 *   1. `createDb(userId)` opens a PER-ACCOUNT OPFS file — B never opens A's replica.
 *   2. `clearLocalAccount(db, confirm)` (the helper App.tsx calls on sign-out)
 *      disconnectAndClear()s A's replica + command queue AND clears the in-memory
 *      SWR read cache — so B neither sees A's cached rows nor uploads A's commands.
 *
 * `@powersync/web` is mocked to capture the db filename; `@powersync/react` is
 * mocked (as in loading-aware.test.ts) so the real provider + review-inbox read
 * run over controllable data. `createElement` (no JSX) → no extra transform config.
 * The end-to-end browser flow belongs in an e2e spec (needs the live stack).
 */
import { createElement } from 'react';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

// ── @powersync/web: capture every PowerSyncDatabase construction's filename.
const dbFilenames: string[] = [];
vi.mock('@powersync/web', () => ({
  PowerSyncDatabase: class {
    constructor(opts: { database: { dbFilename: string } }) {
      dbFilenames.push(opts.database.dbFilename);
    }
  },
}));

// ── @powersync/react: drive hasSynced + per-table loading/rows across renders.
const state = { hasSynced: false, reviewLoading: true, reviewData: undefined as Row[] | undefined };
const A_REVIEW: Row = {
  id: 'rA', user_id: 'alice', item_type: 'command_rejection', severity: 'warning', title: "A's item",
  detail: '{}', status: 'open', command_id: 'cA', deleted_at: null, created_at: '2026-01-02T00:00:00Z',
};
vi.mock('@powersync/react', () => ({
  useQuery: (sql: string) => {
    if (/overlay_effects/i.test(sql)) return { data: [], isLoading: false, isFetching: false };
    if (/from\s+sync_review_items/i.test(sql))
      return { data: state.reviewLoading ? undefined : state.reviewData, isLoading: state.reviewLoading, isFetching: false };
    return { data: state.hasSynced ? [] : undefined, isLoading: !state.hasSynced, isFetching: false };
  },
  useStatus: () => ({ hasSynced: state.hasSynced }),
  usePowerSync: () => ({}),
}));

// Imported AFTER the mocks (vitest hoists vi.mock).
import { clearLocalAccount, createDb } from '../src/powersync';
import { PrismsDataProvider, useReviewInbox, useReviewInboxHydrated, __resetReadCacheForTests } from '@prisms/ui';

function Probe() {
  const items = useReviewInbox();
  const hydrated = useReviewInboxHydrated();
  return createElement('div', { 'data-testid': 'probe', 'data-hydrated': String(hydrated), 'data-count': String(items.length) });
}
function Root({ show }: { show: boolean }) {
  return createElement(PrismsDataProvider, null, show ? createElement(Probe) : createElement('div', { 'data-testid': 'away' }, 'away'));
}
const readProbe = () => {
  const el = screen.getByTestId('probe');
  return { hydrated: el.getAttribute('data-hydrated'), count: el.getAttribute('data-count') };
};

/** A fake PowerSyncDatabase with just the two methods clearLocalAccount touches. */
function fakeDb(pending: number) {
  const disconnectAndClear = vi.fn(async () => {});
  const db = { getAll: async () => [{ n: pending }], disconnectAndClear } as unknown as Parameters<typeof clearLocalAccount>[0];
  return { db, disconnectAndClear };
}

beforeEach(() => {
  __resetReadCacheForTests();
  dbFilenames.length = 0;
  state.hasSynced = false;
  state.reviewLoading = true;
  state.reviewData = undefined;
});
afterEach(() => cleanup());

describe('S9-F1 logout boundary — per-account isolation + local wipe', () => {
  it('createDb opens a PER-ACCOUNT file, so B never opens A’s replica or queue', () => {
    createDb('alice');
    createDb('bob');
    expect(dbFilenames).toEqual(['prisms-alice.db', 'prisms-bob.db']);
    expect(dbFilenames[0]).not.toBe(dbFilenames[1]);
  });

  it('sign-out with unsynced commands + a declined warning keeps them (no wipe, stays signed in)', async () => {
    const { db, disconnectAndClear } = fakeDb(3);
    const confirm = vi.fn(() => false); // user cancels at the warning
    const cleared = await clearLocalAccount(db, confirm);
    expect(confirm).toHaveBeenCalledWith(3);
    expect(cleared).toBe(false);
    expect(disconnectAndClear).not.toHaveBeenCalled(); // A's replica + queue preserved
  });

  it('sign-out with no unsynced commands wipes without prompting', async () => {
    const { db, disconnectAndClear } = fakeDb(0);
    const confirm = vi.fn(() => true);
    const cleared = await clearLocalAccount(db, confirm);
    expect(confirm).not.toHaveBeenCalled(); // nothing to lose → no prompt
    expect(cleared).toBe(true);
    expect(disconnectAndClear).toHaveBeenCalledTimes(1);
  });

  it('simulated A→B switch: sign-out clears the account so B renders no A rows and A’s queue is wiped', async () => {
    // user A: synced, one review row → the screen renders A's row (SWR cache warm)
    state.hasSynced = true;
    state.reviewLoading = false;
    state.reviewData = [A_REVIEW];
    const { rerender } = render(createElement(Root, { show: true }));
    expect(readProbe()).toEqual({ hydrated: 'true', count: '1' });

    // A navigates away (screen unmounts), then signs out via the REAL helper
    rerender(createElement(Root, { show: false }));
    const { db, disconnectAndClear } = fakeDb(2);
    expect(await clearLocalAccount(db, () => true)).toBe(true);
    expect(disconnectAndClear).toHaveBeenCalledTimes(1); // A's queue gone → nothing to cross-post under B

    // user B: fresh replica, first sync not complete → the review query is COLD
    state.hasSynced = false;
    state.reviewLoading = true;
    state.reviewData = undefined;
    rerender(createElement(Root, { show: true }));

    // clearLocalAccount ran clearReadCaches(), so the SWR layer serves nothing —
    // B sees a skeleton (not hydrated, 0 rows), never A's cached row.
    expect(readProbe()).toEqual({ hydrated: 'false', count: '0' });
  });

  it('control: WITHOUT the sign-out clear the SWR cache bleeds A’s row into B (why the wipe matters)', () => {
    state.hasSynced = true;
    state.reviewLoading = false;
    state.reviewData = [A_REVIEW];
    const { rerender } = render(createElement(Root, { show: true }));
    expect(readProbe()).toEqual({ hydrated: 'true', count: '1' });

    rerender(createElement(Root, { show: false })); // navigate away — NO cache clear
    state.hasSynced = false;
    state.reviewLoading = true; // B: cold query, no data of its own yet
    state.reviewData = undefined;
    rerender(createElement(Root, { show: true }));

    // count 1: the stale A row is served from the module cache and WOULD render for
    // B — the exact S8-F2 bleed the sign-out clear closes (contrast the count 0 in
    // the previous test). (hydrated is false only because B has not synced; a
    // non-empty read renders its rows regardless of the hydration/skeleton flag.)
    expect(readProbe()).toEqual({ hydrated: 'false', count: '1' });
  });
});
