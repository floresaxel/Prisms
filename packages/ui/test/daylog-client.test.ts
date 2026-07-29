/**
 * V3 — the client read path for the journal day log (Annex L), on a REAL SQLite
 * store (better-sqlite3) so the actual overlay SQL runs.
 *
 * `useDayLog` is `computeDayLog` over the provider's MERGED rows, so this suite
 * drives exactly that composition — merged replica ⊕ overlay → the same core
 * call the hook makes — without a React renderer (packages/ui has none; the
 * render-level proof is the V4 component tests and the V5 e2e).
 *
 * What it pins:
 *  - offline-instant: a pending `node.check_off` shows in the footer with ZERO
 *    write code, and `node.uncheck` removes the line again;
 *  - a cross-day `block.move` re-buckets BOTH days;
 *  - the flag: off ⇒ null, and an OPTIMISTIC `settings.update` flips the output
 *    with no round-trip (this fails if the effects.ts field list omits it);
 *  - no verb knowledge: a completion that arrived as a canonical row (the timer
 *    review path writes `nodes.completed_at` server-side) surfaces identically;
 *  - totality over dirty replica rows;
 *  - D1 structurally: the write-path modules know nothing about day logs.
 */
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildOptimisticEffects,
  createSqlOverlayStore,
  readMergedRows,
  type OverlayStore,
  type SqlExecutor,
} from '../src/index';
import { toScheduleBlock, toNode, toUserSettings } from '../src/powersync/rows';
import { computeDayLog, DEFAULT_JOURNAL_DAY_LOG, type ClientCommand, type DayLogEntries, type OverlayEffect } from '@prisms/core';

let db: Database.Database;
let store: OverlayStore;

const CTX = { userId: 'u1', deviceId: 'web-1', now: '2026-05-08T18:00:00.000Z' };
const DAY = '2026-05-08';
const NEXT = '2026-05-09';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE client_commands (id TEXT PRIMARY KEY, name TEXT, hlc TEXT, payload TEXT, status TEXT, created_at TEXT, command_version INTEGER, schema_version INTEGER, client_version TEXT, depends_on TEXT);
    CREATE TABLE overlay_effects (id TEXT PRIMARY KEY, command_id TEXT, hlc TEXT, table_name TEXT, row_id TEXT, op TEXT, fields TEXT, seq INTEGER, created_at TEXT);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, user_id TEXT, parent_id TEXT, node_type TEXT, title TEXT, description TEXT, sort_order TEXT, start_date TEXT, due_date TEXT, estimate_minutes INTEGER, completed_at TEXT, completion_disposition TEXT, completed_in_block_id TEXT, habit_id TEXT, attributes TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE schedule_blocks (id TEXT PRIMARY KEY, user_id TEXT, task_id TEXT, starts_at TEXT, ends_at TEXT, anchor_type TEXT, rrule TEXT, status TEXT, suggestion_reason TEXT, computed_at TEXT, external_event_id TEXT, suggestion_batch_id TEXT, replaces_block_id TEXT, superseded_at TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE user_settings (id TEXT PRIMARY KEY, day_reset_hour INTEGER, timezone TEXT, weather_location TEXT, journal_day_log INTEGER, updated_at TEXT);
  `);
  const run = async (sql: string, params: unknown[] = []): Promise<void> => {
    db.prepare(sql).run(...(params as never[]));
  };
  const all = async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => db.prepare(sql).all(...(params as never[])) as T[];
  const tx = { execute: run, getAll: all };
  const exec: SqlExecutor = { execute: run, getAll: all, writeTransaction: async (fn) => fn(tx) };
  store = createSqlOverlayStore(exec);
  db.prepare('INSERT INTO user_settings (id, day_reset_hour, timezone, weather_location, journal_day_log, updated_at) VALUES (?,4,?,NULL,1,?)')
    .run(CTX.userId, 'UTC', CTX.now);
});
afterEach(() => db.close());

/** A canonical (synced) task row. */
function canonicalTask(id: string, title: string, completedAt: string | null = null): void {
  db.prepare(`INSERT INTO nodes (id, user_id, parent_id, node_type, title, description, sort_order, start_date, due_date, estimate_minutes, completed_at, completion_disposition, completed_in_block_id, habit_id, attributes, created_at, updated_at, deleted_at)
              VALUES (?,?,NULL,'task',?,'','a0',NULL,NULL,NULL,?,?,NULL,NULL,'{}',?,?,NULL)`)
    .run(id, CTX.userId, title, completedAt, completedAt === null ? null : 'completed', CTX.now, CTX.now);
}
function canonicalBlock(id: string, taskId: string, starts: string, ends: string): void {
  db.prepare(`INSERT INTO schedule_blocks (id, user_id, task_id, starts_at, ends_at, anchor_type, rrule, status, suggestion_reason, computed_at, external_event_id, suggestion_batch_id, replaces_block_id, superseded_at, created_at, updated_at, deleted_at)
              VALUES (?,?,?,?,?,'none',NULL,'committed',NULL,NULL,NULL,NULL,NULL,NULL,?,?,NULL)`)
    .run(id, CTX.userId, taskId, starts, ends, CTX.now, CTX.now);
}

/** Queue a command the way `execute()` does: envelope + its optimistic effects. */
async function offline(name: string, payload: Record<string, unknown>, hlc: string): Promise<void> {
  const effects = buildOptimisticEffects(name as never, payload, CTX) as OverlayEffect[];
  const cmd: ClientCommand = { id: `cmd-${hlc}`, name: name as never, hlc, payload: payload as never, status: 'pending', created_at: CTX.now };
  await store.enqueue(cmd, effects.map((e) => ({ ...e, command_id: cmd.id, hlc, seq: 0 })));
}

/**
 * EXACTLY what `useDayLog` computes: merged nodes/blocks/settings → computeDayLog,
 * with the flag consulted first.
 */
async function dayLog(date: string): Promise<DayLogEntries | null> {
  const [settingsRow] = await readMergedRows(store, 'user_settings');
  const settings = settingsRow ? toUserSettings(settingsRow) : null;
  if (!(settings?.journal_day_log ?? DEFAULT_JOURNAL_DAY_LOG)) return null;
  const nodes = (await readMergedRows(store, 'nodes')).map(toNode);
  const blocks = (await readMergedRows(store, 'schedule_blocks')).map(toScheduleBlock);
  return computeDayLog({
    date,
    nodes,
    blocks,
    dayResetHour: settings?.day_reset_hour ?? 4,
    timezone: settings?.timezone ?? 'UTC',
  });
}

describe('offline-instant: the footer updates with no write code', () => {
  it('a PENDING node.check_off appears immediately; node.uncheck removes it', async () => {
    canonicalTask('t1', 'Ship the thing');
    expect(await dayLog(DAY)).toBeNull(); // nothing done yet, nothing scheduled

    await offline('node.check_off', { id: 't1', completed_at: `${DAY}T18:00:00.000Z`, completed_in_block_id: null }, 'hlc1');
    const done = await dayLog(DAY);
    expect(done!.completed.map((c) => c.title)).toEqual(['Ship the thing']);
    expect(done!.completed[0]!.planned).toBe(false);

    await offline('node.uncheck', { id: 't1' }, 'hlc2');
    expect(await dayLog(DAY)).toBeNull(); // the line is GONE — a snapshot, not history
  });

  it('a pending node.rename retitles the line', async () => {
    canonicalTask('t1', 'old name', `${DAY}T18:00:00.000Z`);
    await offline('node.rename', { id: 't1', title: 'new name 🚀' }, 'hlc1');
    expect((await dayLog(DAY))!.completed[0]!.title).toBe('new name 🚀');
  });

  it('a pending block.create marks the completion PLANNED', async () => {
    canonicalTask('t1', 'Ship it', `${DAY}T18:00:00.000Z`);
    expect((await dayLog(DAY))!.completed[0]!.planned).toBe(false);
    await offline('block.create', { id: 'b1', task_id: 't1', starts_at: `${DAY}T17:00:00.000Z`, ends_at: `${DAY}T18:30:00.000Z` }, 'hlc1');
    const log = (await dayLog(DAY))!;
    expect(log.scheduled[0]!.done).toBe(true);
    expect(log.completed[0]!.planned).toBe(true);
  });

  it('a pending node.soft_delete erases the task from the day', async () => {
    canonicalTask('t1', 'Ship it', `${DAY}T18:00:00.000Z`);
    await offline('node.soft_delete', { id: 't1' }, 'hlc1');
    expect(await dayLog(DAY)).toBeNull();
  });
});

describe('cross-day block.move re-buckets BOTH days', () => {
  it('moves the scheduled line from one day to the next', async () => {
    canonicalTask('t1', 'Deep work');
    canonicalBlock('b1', 't1', `${DAY}T17:00:00.000Z`, `${DAY}T18:30:00.000Z`);
    expect((await dayLog(DAY))!.scheduled).toHaveLength(1);
    expect(await dayLog(NEXT)).toBeNull();

    await offline('block.move', { id: 'b1', starts_at: `${NEXT}T17:00:00.000Z`, ends_at: `${NEXT}T18:30:00.000Z` }, 'hlc1');
    expect(await dayLog(DAY)).toBeNull();
    expect((await dayLog(NEXT))!.scheduled[0]!.starts_at).toBe(`${NEXT}T17:00:00.000Z`);
  });
});

describe('the flag', () => {
  it('OFF ⇒ null on every day; an OPTIMISTIC settings.update flips it with no round-trip', async () => {
    canonicalTask('t1', 'Ship it', `${DAY}T18:00:00.000Z`);
    expect(await dayLog(DAY)).not.toBeNull();

    await offline('settings.update', { journal_day_log: false }, 'hlc1');
    expect(await dayLog(DAY)).toBeNull(); // fails if effects.ts omits the field

    await offline('settings.update', { journal_day_log: true }, 'hlc2');
    // back ON: everything that happened while it was off is simply there again
    expect((await dayLog(DAY))!.completed).toHaveLength(1);
  });

  it('maps SQLite 0/1 with ABSENT ⇒ ON', () => {
    expect(toUserSettings({ journal_day_log: 1 }).journal_day_log).toBe(true);
    expect(toUserSettings({ journal_day_log: 0 }).journal_day_log).toBe(false);
    expect(toUserSettings({}).journal_day_log).toBe(true); // never synced the column
    expect(toUserSettings({ journal_day_log: null }).journal_day_log).toBe(true);
  });
});

describe('no verb knowledge (D5)', () => {
  it('a completion written by the timer review path surfaces identically', async () => {
    // `timer.review` has no client-side node effect — a completing review sets
    // nodes.completed_at on the SERVER, and it arrives as a canonical row. The
    // read path never learned a verb, so it shows up anyway.
    canonicalTask('t1', 'Focus session');
    expect(await dayLog(DAY)).toBeNull();
    db.prepare('UPDATE nodes SET completed_at = ?, completion_disposition = ? WHERE id = ?')
      .run(`${DAY}T19:30:00.000Z`, 'completed', 't1');
    expect((await dayLog(DAY))!.completed.map((c) => c.title)).toEqual(['Focus session']);
  });

  it('a descoped completion carries its disposition through the mapper', async () => {
    canonicalTask('t1', 'Dead idea');
    db.prepare('UPDATE nodes SET completed_at = ?, completion_disposition = ? WHERE id = ?')
      .run(`${DAY}T19:30:00.000Z`, 'obsolete', 't1');
    expect((await dayLog(DAY))!.completed[0]!.disposition).toBe('obsolete');
  });
});

describe('totality over dirty replica rows', () => {
  it('malformed or absent fact fields never throw', async () => {
    db.prepare('INSERT INTO nodes (id, user_id, node_type, completed_at) VALUES (?,?,?,?)').run('bad1', CTX.userId, 'task', 'not-a-date');
    db.prepare('INSERT INTO nodes (id, user_id) VALUES (?,?)').run('bad2', CTX.userId);
    db.prepare('INSERT INTO schedule_blocks (id, user_id, task_id, starts_at, ends_at, status) VALUES (?,?,?,?,?,?)')
      .run('bb1', CTX.userId, 'bad2', '', 'nope', 'committed');
    canonicalTask('t1', 'fine', `${DAY}T18:00:00.000Z`);
    const log = await dayLog(DAY);
    expect(log!.completed.map((c) => c.title)).toEqual(['fine']); // dirty rows filtered, not fatal
  });
});

describe('D1: the write path knows nothing about day logs', () => {
  it('execute.ts, upload-commands.ts and overlay-store.ts are untouched by the feature', () => {
    for (const file of ['execute.ts', 'upload-commands.ts', 'overlay-store.ts']) {
      const src = readFileSync(new URL(`../src/powersync/${file}`, import.meta.url), 'utf8');
      expect(/day.?log/i.test(src), `${file} must not know about day logs`).toBe(false);
    }
    // effects.ts changes for the SETTINGS FIELD only — no day-log table effect.
    const effects = readFileSync(new URL('../src/powersync/effects.ts', import.meta.url), 'utf8');
    expect(effects.split('\n').filter((l) => /journal_day_log/.test(l))).toHaveLength(1);
    expect(/day_logs\b/.test(effects)).toBe(false);
  });
});
