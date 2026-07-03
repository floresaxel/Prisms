// @vitest-environment jsdom
/**
 * M11 (Fix A, §7.14) + R7 (S8-F1) runtime DoD: `PrismsDataProvider`, mounted above
 * the router, creates its shared subscriptions ONCE and SEEDS the fact index once —
 * it does NOT reseed on navigation, on the `now` tick, OR on a data change (an
 * optimistic overlay write). A data change is applied INCREMENTALLY to the live
 * index (S8-F1), so the merged FactContext reflects it without a full rebuild.
 *
 * `@powersync/react` is mocked so `useQuery` returns controllable data (and we can
 * count subscription SQLs); the `StatusIndex` constructor is wrapped to count seeds.
 * Uses `createElement` (no JSX) so it needs no extra vitest transform config.
 */
import { createElement, Fragment, useState } from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

// Stable module-level row refs so the provider's memos hold across re-renders (a
// real WatchedQuery returns the same array identity until the data actually changes).
const NODES: Row[] = [
  { id: 'n1', user_id: 'u1', node_type: 'task', title: 'V', sort_order: 'a0', attributes: '{}', deleted_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
];
const EMPTY: Row[] = [];
// A mutable overlay the rename test swaps in (a pending `node.rename` effect on n1).
let OVERLAY: Row[] = [];
const RENAME_EFFECT: Row = { command_id: 'c1', hlc: '000000000001-0000-dev', table_name: 'nodes', row_id: 'n1', op: 'update', fields: '{"title":"RENAMED"}', seq: 0 };

const useQueryCalls: string[] = [];
function dataFor(sql: string): Row[] {
  if (/overlay_effects/i.test(sql)) return OVERLAY;
  if (/from\s+nodes\b/i.test(sql)) return NODES;
  return EMPTY;
}

vi.mock('@powersync/react', () => ({
  useQuery: (sql: string) => {
    useQueryCalls.push(sql);
    return { data: dataFor(sql), isLoading: false, isFetching: false };
  },
  useStatus: () => ({ hasSynced: true }),
}));

// Count StatusIndex seeds (constructions) — the expensive base build the provider
// must run ONCE, not per change.
const h = vi.hoisted(() => ({ seeds: 0 }));
vi.mock('@prisms/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisms/core')>();
  class CountingIndex extends actual.StatusIndex {
    constructor(...args: ConstructorParameters<typeof actual.StatusIndex>) {
      super(...args);
      h.seeds += 1;
    }
  }
  return { ...actual, StatusIndex: CountingIndex };
});

// Imported AFTER the mocks (vitest hoists vi.mock).
import { PrismsDataProvider, useFactContext } from '@prisms/ui';

function ScreenA() {
  useFactContext();
  return createElement('div', { 'data-testid': 'screen' }, 'A');
}
function ScreenB() {
  useFactContext();
  return createElement('div', { 'data-testid': 'screen' }, 'B');
}

/** A tiny router: the nav button (outside the provider) swaps the screen inside it. */
function Harness() {
  const [route, setRoute] = useState('a');
  return createElement(
    Fragment,
    null,
    createElement('button', { 'data-testid': 'nav', onClick: () => setRoute((r) => (r === 'a' ? 'b' : 'a')) }, 'nav'),
    createElement(PrismsDataProvider, null, route === 'a' ? createElement(ScreenA) : createElement(ScreenB)),
  );
}

/** A screen with a per-second `now` tick — the ONLY state that changes here. */
function TickingScreen() {
  const [, setNow] = useState(0);
  useFactContext();
  return createElement(
    Fragment,
    null,
    createElement('button', { 'data-testid': 'tick', onClick: () => setNow((n) => n + 1) }, 'tick'),
    createElement('div', { 'data-testid': 'screen' }, 'S'),
  );
}

function TickHarness() {
  return createElement(PrismsDataProvider, null, createElement(TickingScreen));
}

/** A screen that renders n1's merged title, plus a button that adds the overlay rename. */
function RenameScreen() {
  const ctx = useFactContext();
  return createElement('div', { 'data-testid': 'title' }, (ctx.node('n1')?.title as string) ?? '');
}
function RenameHarness() {
  const [, force] = useState(0);
  return createElement(
    Fragment,
    null,
    createElement('button', { 'data-testid': 'rename', onClick: () => { OVERLAY = [RENAME_EFFECT]; force((x) => x + 1); } }, 'rename'),
    createElement(PrismsDataProvider, null, createElement(RenameScreen)),
  );
}

afterEach(() => {
  cleanup();
  useQueryCalls.length = 0;
  OVERLAY = [];
  h.seeds = 0;
});

describe('§7.14/§7.12 PrismsDataProvider — seed-once + incremental maintenance', () => {
  it('subscribes the 9 shared tables + overlay once, seeds the index once, and neither repeats on navigation', () => {
    render(createElement(Harness));
    expect(screen.getByTestId('screen').textContent).toBe('A');

    // one seed on mount
    expect(h.seeds).toBe(1);
    // exactly the 9 shared base subscriptions + the single overlay read
    const distinctBefore = new Set(useQueryCalls);
    expect(distinctBefore.size).toBe(10);

    // navigate back and forth several times (the child screen unmounts/remounts)
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByTestId('nav'));

    expect(screen.getByTestId('screen').textContent).toBe('A'); // swapped A→B→A→B→A
    // …yet the fact index was NOT reseeded and NO new base subscription was opened
    expect(h.seeds).toBe(1);
    expect(new Set(useQueryCalls)).toEqual(distinctBefore);
  });

  it('a screen-local `now` tick does not reseed the fact index (§7.15 item 4)', () => {
    render(createElement(TickHarness));
    expect(h.seeds).toBe(1);
    for (let i = 0; i < 5; i += 1) fireEvent.click(screen.getByTestId('tick'));
    expect(h.seeds).toBe(1);
  });

  it('an optimistic overlay write is applied INCREMENTALLY — merged read updates, no reseed (S8-F1)', () => {
    render(createElement(RenameHarness));
    expect(h.seeds).toBe(1);
    expect(screen.getByTestId('title').textContent).toBe('V'); // canonical

    fireEvent.click(screen.getByTestId('rename')); // add the pending overlay rename

    // the merged FactContext reflects the optimistic title …
    expect(screen.getByTestId('title').textContent).toBe('RENAMED');
    // … WITHOUT rebuilding the index (the whole point of S8-F1)
    expect(h.seeds).toBe(1);
  });
});
