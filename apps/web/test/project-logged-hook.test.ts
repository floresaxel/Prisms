// @vitest-environment jsdom
/**
 * `useProjectLoggedMinutes` through the real `PrismsDataProvider`: a project's
 * total is the time logged in every task under it — a task inside a milestone and
 * a finished one included — and it follows the data as a session is logged
 * (here as pending local writes, the way a clock-out lands before it syncs).
 * `@powersync/react` is mocked so the tables and the overlay are controllable.
 */
import { createElement, Fragment, useState } from 'react';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const T = '2026-01-01T00:00:00Z';
const node = (id: string, type: string, parent: string | null, extra: Row = {}): Row => ({
  id, user_id: 'u1', node_type: type, parent_id: parent, title: id, sort_order: id, attributes: '{}', deleted_at: null, created_at: T, updated_at: T, ...extra,
});
const NODES: Row[] = [
  node('p1', 'project', null),
  node('ms', 'milestone', 'p1'),
  node('t-direct', 'task', 'p1'),
  node('t-nested', 'task', 'ms'),
  node('t-done', 'task', 'p1', { completed_at: T, completion_disposition: 'completed' }),
  node('p2', 'project', null),
  node('t-other', 'task', 'p2'),
];
const EMPTY: Row[] = [];
let OVERLAY: Row[] = [];

/** A pending, not-yet-synced session: a whole `time_entries` row from `from` to `to` (ISO times). */
function session(id: string, task: string, from: string, to: string, hlc: number): Row {
  const row = { id, user_id: 'u1', task_id: task, started_at: from, ended_at: to, focus_factor: null, completed_session: null, planned: 0, device_id: 'd1', deleted_at: null, created_at: from, updated_at: to };
  return { command_id: `c${hlc}`, hlc: `${String(hlc).padStart(12, '0')}-0000-dev`, table_name: 'time_entries', row_id: id, op: 'insert', seq: 0, fields: JSON.stringify(row) };
}
const day = (hh: number, mm = 0) => `2026-01-02T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`;

vi.mock('@powersync/react', () => ({
  useQuery: (sql: string) => {
    if (/overlay_effects/i.test(sql)) return { data: OVERLAY, isLoading: false, isFetching: false };
    if (/from\s+nodes\b/i.test(sql)) return { data: NODES, isLoading: false, isFetching: false };
    return { data: EMPTY, isLoading: false, isFetching: false };
  },
  useStatus: () => ({ hasSynced: true }),
}));

// Imported AFTER the mock (vitest hoists vi.mock).
import { __resetReadCacheForTests, PrismsDataProvider, useProjectLoggedMinutes } from '@prisms/ui';

function Totals() {
  const totals = useProjectLoggedMinutes();
  return createElement('div', { 'data-testid': 'totals' }, ['p1', 'p2'].map((id) => `${id}=${totals.get(id) ?? 0}`).join(' '));
}
function Harness({ steps }: { steps: Row[][] }) {
  const [at, setAt] = useState(0);
  return createElement(
    Fragment,
    null,
    createElement('button', { 'data-testid': 'log', onClick: () => { OVERLAY = steps[at]!; setAt((n) => n + 1); } }, 'log'),
    createElement(PrismsDataProvider, null, createElement(Totals)),
  );
}
const totals = () => screen.getByTestId('totals').textContent;

afterEach(() => {
  cleanup();
  OVERLAY = [];
  __resetReadCacheForTests();
});

describe('useProjectLoggedMinutes', () => {
  it('starts empty, then totals every task under a project as time is logged', () => {
    const direct = session('e1', 't-direct', day(9), day(10), 1); // 60
    const nested = session('e2', 't-nested', day(11), day(11, 30), 2); // 30, inside a milestone
    const done = session('e3', 't-done', day(13), day(13, 15), 3); // 15, a finished task
    const other = session('e4', 't-other', day(15), day(16), 4); // 60, another project
    render(createElement(Harness, { steps: [[direct], [direct, nested], [direct, nested, done, other]] }));
    expect(totals()).toBe('p1=0 p2=0');

    fireEvent.click(screen.getByTestId('log'));
    expect(totals()).toBe('p1=60 p2=0');
    fireEvent.click(screen.getByTestId('log'));
    expect(totals()).toBe('p1=90 p2=0');
    fireEvent.click(screen.getByTestId('log'));
    expect(totals()).toBe('p1=105 p2=60');
  });
});
