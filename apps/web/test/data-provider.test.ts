// @vitest-environment jsdom
/**
 * M11 (Fix A, §7.14) runtime DoD: `PrismsDataProvider`, mounted above the router,
 * creates its shared subscriptions ONCE and does NOT rebuild `FactContext` when the
 * screen below it swaps (navigation). This is the counter half of the DoD; the
 * static "no screen subscribes a shared table" half lives in
 * packages/ui/test/read-layer.test.ts.
 *
 * `@powersync/react` is mocked so `useQuery` returns stable data (and we can count
 * subscription SQLs), and `buildFactContext` is wrapped to count derivations.
 * Uses `createElement` (no JSX) so it needs no extra vitest transform config.
 */
import { createElement, Fragment, useState } from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Stable module-level row refs so the provider's memos hold across re-renders (a
// real WatchedQuery returns the same array identity until the data actually changes).
const NODES: Record<string, unknown>[] = [
  { id: 'n1', user_id: 'u1', node_type: 'vision', title: 'V', sort_order: 'a0', attributes: '{}', deleted_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
];
const EMPTY: Record<string, unknown>[] = [];
const OVERLAY: Record<string, unknown>[] = [];

const useQueryCalls: string[] = [];
function dataFor(sql: string): Record<string, unknown>[] {
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

vi.mock('@prisms/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisms/core')>();
  return { ...actual, buildFactContext: vi.fn(actual.buildFactContext) };
});

// Imported AFTER the mocks (vitest hoists vi.mock): buildFactContext is the spy.
import { buildFactContext } from '@prisms/core';
import { PrismsDataProvider, useFactContext } from '@prisms/ui';

const buildSpy = buildFactContext as unknown as ReturnType<typeof vi.fn>;

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

afterEach(() => {
  cleanup();
  useQueryCalls.length = 0;
  buildSpy.mockClear();
});

describe('§7.14 PrismsDataProvider — build-count + subscription-count invariant across navigation', () => {
  it('subscribes the 9 shared tables + overlay once, builds FactContext once, and neither repeats on navigation', () => {
    render(createElement(Harness));
    expect(screen.getByTestId('screen').textContent).toBe('A');

    // one derivation on mount
    const buildsAfterMount = buildSpy.mock.calls.length;
    expect(buildsAfterMount).toBe(1);

    // exactly the 9 shared base subscriptions + the single overlay read
    const distinctBefore = new Set(useQueryCalls);
    expect(distinctBefore.size).toBe(10);

    // navigate back and forth several times (the child screen unmounts/remounts)
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByTestId('nav'));

    // the screen actually swapped (A→B→A→B→A), proving navigation happened
    expect(screen.getByTestId('screen').textContent).toBe('A');
    // …yet the fact index was NOT rebuilt and NO new base subscription was opened
    expect(buildSpy.mock.calls.length).toBe(buildsAfterMount);
    expect(new Set(useQueryCalls)).toEqual(distinctBefore);
  });
});
