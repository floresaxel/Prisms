// @vitest-environment jsdom
/**
 * The Review screen's long-session card: confirm the time, or fix it by "time
 * actually spent" or "exact clock-out time" — a running timer is clocked out at
 * the chosen end, a closed one is adjusted; either way the item is resolved.
 * `@prisms/ui` data hooks are mocked (no PowerSync runtime).
 */
import { createElement } from 'react';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LongSessionView, ReviewItemView } from '@prisms/ui';

const H = 3_600_000;
const NOW = Date.parse('2026-11-17T17:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const state = { items: [] as ReviewItemView[], sessions: new Map<string, LongSessionView>() };
const commandFns = new Map<string, ReturnType<typeof vi.fn>>();
const command = (name: string) => {
  if (!commandFns.has(name)) commandFns.set(name, vi.fn(async () => undefined));
  return commandFns.get(name)!;
};
const commands = new Proxy({} as Record<string, unknown>, { get: (_t, p: string) => command(p) });

vi.mock('@prisms/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisms/ui')>();
  return {
    ...actual,
    useCommands: () => commands,
    useReviewInbox: () => state.items,
    useReviewInboxHydrated: () => true,
    useLongSessions: () => state.sessions,
    useUserSettings: () => ({ hasRow: true, dayResetHour: 4, timezone: 'UTC', weatherLocation: null, journalDayLog: true }),
  };
});

const { Review } = await import('../src/screens/Review');

function longItem(id: string, kind: 'over_6h' | 'auto_clock_out', startedAt: number, endedAt: number | null): void {
  const detail = { kind, entry_id: `entry-${id}`, task_id: 'task-1', started_at: iso(startedAt), ended_at: endedAt === null ? null : iso(endedAt) };
  state.items.push({ id, itemType: 'long_session', severity: 'warning', title: `Long ${id}`, detail: JSON.stringify(detail), status: 'open', commandId: null, createdAt: iso(NOW) });
  state.sessions.set(id, {
    detail,
    taskTitle: 'Write report',
    entry: {
      id: `entry-${id}`, user_id: 'u', task_id: 'task-1', started_at: iso(startedAt), ended_at: endedAt === null ? null : iso(endedAt),
      focus_factor: null, completed_session: null, planned: true, device_id: 'd',
    } as unknown as NonNullable<LongSessionView['entry']>,
  });
}

const renderReview = () => render(createElement(Review, { ctx: { userId: 'u', deviceId: 'd' } }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.items = [];
  state.sessions = new Map();
  commandFns.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('long-session review card', () => {
  it('a running 7 h session: "Yes, still working" just confirms it', () => {
    longItem('a', 'over_6h', NOW - 7 * H, null);
    renderReview();
    expect(screen.getByTestId('ls-status-a').textContent).toContain('still running · 7h 00m so far');
    fireEvent.click(screen.getByTestId('ls-confirm-a'));
    expect(command('resolveReviewItem')).toHaveBeenCalledWith('a');
    expect(command('clockOut')).not.toHaveBeenCalled();
  });

  it('a running session: clock out by time actually spent', async () => {
    const start = NOW - 7 * H;
    longItem('a', 'over_6h', start, null);
    renderReview();
    fireEvent.click(screen.getByTestId('ls-edit-a'));
    expect((screen.getByTestId('ls-hours-a') as HTMLInputElement).value).toBe('7');
    fireEvent.change(screen.getByTestId('ls-hours-a'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('ls-minutes-a'), { target: { value: '15' } });
    // the exact-time field follows the duration
    expect((screen.getByTestId('ls-end-a') as HTMLInputElement).value).toBe('2026-11-17T12:15');
    await act(async () => fireEvent.click(screen.getByTestId('ls-save-a')));
    expect(command('clockOut')).toHaveBeenCalledWith('entry-a', iso(start + 2.25 * H));
    expect(command('resolveReviewItem')).toHaveBeenCalledWith('a');
  });

  it('an auto clocked-out session: log the exact clock-out time', async () => {
    const start = NOW - 30 * H;
    longItem('b', 'auto_clock_out', start, start + 24 * H);
    renderReview();
    expect(screen.getByTestId('ls-status-b').textContent).toContain('ran 24h 00m');
    expect(screen.getByTestId('ls-status-b').textContent).toContain('automatic clock-out');
    fireEvent.click(screen.getByTestId('ls-edit-b'));
    fireEvent.change(screen.getByTestId('ls-end-b'), { target: { value: '2026-11-16T19:30' } });
    expect((screen.getByTestId('ls-hours-b') as HTMLInputElement).value).toBe('8');
    expect((screen.getByTestId('ls-minutes-b') as HTMLInputElement).value).toBe('30');
    await act(async () => fireEvent.click(screen.getByTestId('ls-save-b')));
    expect(command('adjustEntryEnd')).toHaveBeenCalledWith('entry-b', '2026-11-16T19:30:00.000Z');
    expect(command('clockOut')).not.toHaveBeenCalled();
    expect(command('resolveReviewItem')).toHaveBeenCalledWith('b');
  });

  it('refuses an end in the future or before the start', () => {
    longItem('c', 'over_6h', NOW - 10 * H, NOW - 2 * H);
    renderReview();
    fireEvent.click(screen.getByTestId('ls-edit-c'));
    fireEvent.change(screen.getByTestId('ls-hours-c'), { target: { value: '12' } });
    expect(screen.getByTestId('ls-error-c').textContent).toMatch(/future/);
    expect((screen.getByTestId('ls-save-c') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('ls-hours-c'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('ls-minutes-c'), { target: { value: '0' } });
    expect(screen.getByTestId('ls-error-c').textContent).toMatch(/after it started/);
  });
});
