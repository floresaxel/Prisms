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

// A screen-local table (read through `useRows`, not the provider) and a pending
// optimistic relabel of its one row.
const TAGS: Row[] = [
  { id: 't1', user_id: 'u1', label: 'Alpha', habit_id: null, deleted_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
];
const RELABEL_EFFECT: Row = { command_id: 'c2', hlc: '000000000002-0000-dev', table_name: 'tags', row_id: 't1', op: 'update', fields: '{"label":"RELABELED"}', seq: 0 };

// A running timer on n1 that is already canonical, and a pending clock-out of it:
// an UPDATE of one column, with no insert beside it in the overlay.
const OPEN_ENTRY: Row = {
  id: 'e1', user_id: 'u1', task_id: 'n1', started_at: '2026-01-01T09:00:00Z', ended_at: null, focus_factor: null,
  completed_session: null, planned: 0, device_id: 'd1', deleted_at: null, created_at: '2026-01-01T09:00:00Z', updated_at: '2026-01-01T09:00:00Z',
};
const CLOCK_OUT_EFFECT: Row = { command_id: 'c3', hlc: '000000000003-0000-dev', table_name: 'time_entries', row_id: 'e1', op: 'update', fields: '{"ended_at":"2026-01-01T10:00:00Z"}', seq: 0 };
// A second timer started on this device and not yet uploaded: a pending INSERT, a whole row.
const CLOCK_IN_EFFECT: Row = {
  command_id: 'c5', hlc: '000000000005-0000-dev', table_name: 'time_entries', row_id: 'e2', op: 'insert', seq: 0,
  fields: JSON.stringify({ ...OPEN_ENTRY, id: 'e2', started_at: '2026-01-01T11:00:00Z' }),
};
// A pending settings.update on a device whose settings row the server has not created yet.
const RESET_HOUR_EFFECT: Row = { command_id: 'c4', hlc: '000000000004-0000-dev', table_name: 'user_settings', row_id: 'u1', op: 'update', fields: '{"day_reset_hour":7}', seq: 0 };
let ENTRY_ROWS: Row[] = EMPTY;
/**
 * Hold the time-entries read in its loading state, the way every read is for a
 * few milliseconds at boot. While it loads, the real `useQuery` hands back an
 * EMPTY ARRAY — not `undefined` — and that placeholder is what got mistaken for
 * a table with no rows in it.
 */
let ENTRIES_LOADING = false;
const LOADING_PLACEHOLDER: Row[] = [];

const useQueryCalls: string[] = [];
function dataFor(sql: string): Row[] {
  if (/overlay_effects/i.test(sql)) return OVERLAY;
  if (/from\s+nodes\b/i.test(sql)) return NODES;
  if (/from\s+tags\b/i.test(sql)) return TAGS;
  if (/from\s+time_entries\b/i.test(sql)) return ENTRY_ROWS;
  return EMPTY;
}

vi.mock('@powersync/react', () => ({
  useQuery: (sql: string) => {
    useQueryCalls.push(sql);
    if (ENTRIES_LOADING && /from\s+time_entries\b/i.test(sql)) return { data: LOADING_PLACEHOLDER, isLoading: true, isFetching: true };
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
import { __resetReadCacheForTests, PrismsDataProvider, useFactContext, usePrismsData, useTagCatalog } from '@prisms/ui';

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

/** A screen over a SCREEN-LOCAL table, plus a button that adds a pending relabel of its row. */
function TagScreen() {
  const tags = useTagCatalog();
  return createElement('div', { 'data-testid': 'tags' }, tags.map((t) => t.label).join(','));
}
function TagHarness() {
  const [, force] = useState(0);
  return createElement(
    Fragment,
    null,
    createElement('button', { 'data-testid': 'relabel', onClick: () => { OVERLAY = [RELABEL_EFFECT]; force((x) => x + 1); } }, 'relabel'),
    createElement(PrismsDataProvider, null, createElement(TagScreen)),
  );
}

/** The merged time entries as the provider serves them, and the fact index built over them. */
function EntryScreen() {
  useFactContext(); // the index is where a time entry with no start threw
  const entries = usePrismsData().rows.time_entries;
  return createElement(
    'div',
    { 'data-testid': 'entries' },
    entries.map((r) => `${String(r['id'])}:${r['ended_at'] == null ? 'running' : 'stopped'}`).join(','),
  );
}
function EntryHarness() {
  const [, force] = useState(0);
  return createElement(
    Fragment,
    null,
    createElement('button', { 'data-testid': 'entries-arrive', onClick: () => { ENTRIES_LOADING = false; force((x) => x + 1); } }, 'arrive'),
    createElement(PrismsDataProvider, null, createElement(EntryScreen)),
  );
}

function ResetHourScreen() {
  return createElement('div', { 'data-testid': 'reset-hour' }, String(useFactContext().dayResetHour));
}

afterEach(() => {
  cleanup();
  useQueryCalls.length = 0;
  OVERLAY = [];
  ENTRY_ROWS = EMPTY;
  ENTRIES_LOADING = false;
  h.seeds = 0;
  __resetReadCacheForTests();
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

  it('a screen-local read merges its overlay from the provider — it opens no overlay watch of its own', () => {
    render(createElement(TagHarness));
    expect(screen.getByTestId('tags').textContent).toBe('Alpha'); // canonical

    fireEvent.click(screen.getByTestId('relabel')); // a pending optimistic write on `tags`

    // the screen-local read shows it, having sliced it out of the shared overlay…
    expect(screen.getByTestId('tags').textContent).toBe('RELABELED');
    // …so the overlay is still subscribed exactly once, by the provider: every
    // watch is a round-trip to the database worker, and a per-read overlay watch
    // was a third of a cold load's queries.
    const overlayReads = new Set(useQueryCalls.filter((sql) => /overlay_effects/i.test(sql)));
    expect(overlayReads.size).toBe(1);
    // the 9 shared tables + the overlay + this screen's one table
    expect(new Set(useQueryCalls).size).toBe(11);
  });

  it('a pending UPDATE is not merged onto a table that has not been read yet — the boot order that blanked the app', () => {
    // Clock out of a timer that had already synced, with the upload unable to go
    // through, then reload. At boot the overlay is read before time_entries, so
    // for a moment the clock-out is in hand and the entry it patches is not.
    ENTRY_ROWS = [OPEN_ENTRY];
    ENTRIES_LOADING = true;
    OVERLAY = [CLOCK_OUT_EFFECT, CLOCK_IN_EFFECT];

    // Merging in that gap made a time entry of `ended_at` alone; with no start it
    // threw in the fact index — at boot, so every reload hit it again, and the
    // upload that would have cleared the command never got to run.
    expect(() => render(createElement(EntryHarness))).not.toThrow();
    // Not read yet means NOTHING is merged — no half-row, and not the pending
    // insert either: the table goes from unread to whole in one step.
    expect(screen.getByTestId('entries').textContent).toBe('');

    fireEvent.click(screen.getByTestId('entries-arrive'));
    // the table arrives: the pending update patches a real row, the pending insert joins it
    expect(screen.getByTestId('entries').textContent).toBe('e1:stopped,e2:running');
  });

  it('a pending update whose row is simply not there is dropped, not shown as a row', () => {
    // read and loaded — but the entry is gone (tombstoned from another device)
    OVERLAY = [CLOCK_OUT_EFFECT];
    expect(() => render(createElement(EntryHarness))).not.toThrow();
    expect(screen.getByTestId('entries').textContent).toBe('');
  });

  it('user_settings is the exception: a pending settings.update shows before the server has created the row', () => {
    // no settings row has ever synced to this device; the server creates it on
    // the first settings.update, so until then the pending update IS the row
    OVERLAY = [RESET_HOUR_EFFECT];
    render(createElement(PrismsDataProvider, null, createElement(ResetHourScreen)));
    expect(screen.getByTestId('reset-hour').textContent).toBe('7');
  });
});
