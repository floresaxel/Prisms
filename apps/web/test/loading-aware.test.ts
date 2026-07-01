// @vitest-environment jsdom
/**
 * M12 (Fix C, §7.15) runtime DoD: the loading-aware, stale-while-revalidate read
 * layer, proven deterministically at the hook level (the behavioral e2e lives in
 * apps/web/e2e/v14.spec.ts, which needs the live stack).
 *
 * A single screen-local read (`sync_review_items`, via `useReviewInbox` +
 * `useReviewInboxHydrated`) exercises all four contracts:
 *   1. fresh login (empty replica, sync in flight)      → NOT hydrated (screen shows a skeleton, not empty)
 *   2. synced + empty                                    → hydrated + empty      (the confirmed-empty branch)
 *   3. offline populated reload (rows local, unsynced)   → hydrated + rows       (no stuck skeleton)
 *   4. tab-away-and-back (cold re-subscribe)             → cached rows + hydrated (warm synchronous revisit)
 *
 * `@powersync/react` is mocked so we can drive `hasSynced`, per-table `isLoading`,
 * and row sets across renders; the provider + real hooks run unmodified. Uses
 * `createElement` (no JSX) so it needs no extra vitest transform config.
 */
import { createElement } from 'react';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

// Controllable mock state — mutated between renders to simulate each scenario.
const state = {
  hasSynced: false,
  baseLoading: true,
  nodes: [] as Row[],
  reviewLoading: true,
  reviewData: undefined as Row[] | undefined,
};

const NODE: Row = {
  id: 'n1', user_id: 'u1', node_type: 'vision', title: 'V', sort_order: 'a0',
  attributes: '{}', deleted_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};
const REVIEW: Row = {
  id: 'r1', user_id: 'u1', item_type: 'command_rejection', severity: 'warning', title: 'Change rejected',
  detail: '{}', status: 'open', command_id: 'c1', deleted_at: null, created_at: '2026-01-02T00:00:00Z',
};

vi.mock('@powersync/react', () => ({
  useQuery: (sql: string) => {
    if (/overlay_effects/i.test(sql)) return { data: [], isLoading: false, isFetching: false };
    if (/from\s+sync_review_items/i.test(sql))
      return { data: state.reviewLoading ? undefined : state.reviewData, isLoading: state.reviewLoading, isFetching: false };
    if (/from\s+nodes\b/i.test(sql))
      return { data: state.baseLoading ? undefined : state.nodes, isLoading: state.baseLoading, isFetching: false };
    return { data: state.baseLoading ? undefined : [], isLoading: state.baseLoading, isFetching: false };
  },
  useStatus: () => ({ hasSynced: state.hasSynced }),
  usePowerSync: () => ({}),
}));

// Imported AFTER the mock (vitest hoists vi.mock).
import { PrismsDataProvider, useReviewInbox, useReviewInboxHydrated, __resetReadCacheForTests } from '@prisms/ui';

function Probe() {
  const items = useReviewInbox();
  const hydrated = useReviewInboxHydrated();
  return createElement('div', {
    'data-testid': 'probe',
    'data-hydrated': String(hydrated),
    'data-count': String(items.length),
  });
}

function Root({ show }: { show: boolean }) {
  return createElement(PrismsDataProvider, null, show ? createElement(Probe) : createElement('div', { 'data-testid': 'away' }, 'away'));
}

const readProbe = () => {
  const el = screen.getByTestId('probe');
  return { hydrated: el.getAttribute('data-hydrated'), count: el.getAttribute('data-count') };
};

beforeEach(() => {
  __resetReadCacheForTests();
  state.hasSynced = false;
  state.baseLoading = true;
  state.nodes = [];
  state.reviewLoading = true;
  state.reviewData = undefined;
});

afterEach(() => cleanup());

describe('§7.15 loading-aware SWR reads — skeleton gating + remount cache', () => {
  it('fresh login (empty replica, sync in flight) is NOT hydrated → a screen shows a skeleton, not empty', () => {
    // nothing synced, every query still loading
    render(createElement(Root, { show: true }));
    // count 0 AND not hydrated → the screen renders `!isHydrated ? skeleton : empty`
    expect(readProbe()).toEqual({ hydrated: 'false', count: '0' });
  });

  it('synced + genuinely empty → hydrated with 0 rows (the confirmed-empty branch renders)', () => {
    state.hasSynced = true;
    state.baseLoading = false;
    state.reviewLoading = false;
    state.reviewData = [];
    render(createElement(Root, { show: true }));
    // hasSynced grounds hydration even though nothing exists → empty branch, no skeleton
    expect(readProbe()).toEqual({ hydrated: 'true', count: '0' });
  });

  it('offline populated reload (rows local, first sync NOT complete) → hydrated with rows, not a stuck skeleton', () => {
    // hasSynced stays false, but a base row + review rows already exist locally
    state.hasSynced = false;
    state.baseLoading = false;
    state.nodes = [NODE];
    state.reviewLoading = false;
    state.reviewData = [REVIEW];
    render(createElement(Root, { show: true }));
    // the "row already exists" fallback grounds hydration without hasSynced
    expect(readProbe()).toEqual({ hydrated: 'true', count: '1' });
  });

  it('tab-away-and-back returns cached rows synchronously on a cold re-subscribe (no empty flash)', () => {
    // 1) first visit, data present and synced
    state.hasSynced = true;
    state.baseLoading = false;
    state.nodes = [NODE];
    state.reviewLoading = false;
    state.reviewData = [REVIEW];
    const { rerender } = render(createElement(Root, { show: true }));
    expect(readProbe()).toEqual({ hydrated: 'true', count: '1' });

    // 2) navigate away — the screen unmounts (its screen-local subscription tears down)
    rerender(createElement(Root, { show: false }));
    expect(screen.queryByTestId('probe')).toBeNull();

    // 3) the review query is COLD again on the way back (isLoading, data undefined)…
    state.reviewLoading = true;
    state.reviewData = undefined;
    rerender(createElement(Root, { show: true }));

    // …yet the read returns the last-known rows from the module cache immediately,
    // and hydration is retained — so the revisit is warm: rows, no skeleton, no empty flash.
    expect(readProbe()).toEqual({ hydrated: 'true', count: '1' });
  });
});
