/**
 * V2 — the ABSENCE audit for Annex L (D1), asserted rather than narrated.
 *
 * The day log's central claim is that it adds NO write-path surface: no table,
 * no writer, no job, no publication entry, no stream table, no client optimistic
 * mirror. Those are exactly the things that would quietly reappear during a later
 * "small fix", so they are pinned here as a test over the real files. Runs
 * everywhere (no database needed).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tables } from '@prisms/db';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * A table name that would mean the log had been materialized. Table names in
 * this schema are plural, so the PLURAL form is the tell — `journal_day_log`
 * (singular) is the settings COLUMN and must not trip this.
 */
const MATERIALIZED = /day_logs\b/;

describe('Annex L adds no write-path surface (D1)', () => {
  it('adds NO table: not in the Drizzle registry, not in the schema file', () => {
    expect(Object.keys(tables).filter((t) => MATERIALIZED.test(t))).toEqual([]);
    expect(Object.keys(tables)).toHaveLength(26); // unchanged by this feature
    const schema = read('packages/db/src/schema.ts');
    expect(/pgTable\(\s*'journal_day_logs?'/.test(schema)).toBe(false);
    // the flag is a COLUMN on user_settings, and only that
    expect(schema).toMatch(/journal_day_log:\s*boolean\('journal_day_log'\)/);
  });

  it('migration 0012 alters no publication and creates no table', () => {
    const sql = read('packages/db/migrations/0012_journal_day_log.sql');
    const statements = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    expect(statements).not.toMatch(/ALTER PUBLICATION/i);
    expect(statements).not.toMatch(/CREATE TABLE/i);
    expect(statements).toMatch(/ALTER TABLE "user_settings" ADD COLUMN "journal_day_log"/);
  });

  it('no migration ever publishes a day-log table', () => {
    const dir = path.join(repoRoot, 'packages/db/migrations');
    const published = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .flatMap((f) => [...readFileSync(path.join(dir, f), 'utf8').matchAll(/ALTER PUBLICATION \w+ ADD TABLE (\w+)/gi)])
      .map((m) => m[1]!);
    expect(published.filter((t) => MATERIALIZED.test(t))).toEqual([]);
  });

  it('the dispatcher gains ONE settings field and no day-log write path', () => {
    const dispatcher = read('apps/server/src/dispatcher.ts');
    const touched = dispatcher.split('\n').filter((l) => l.includes('journal_day_log'));
    expect(touched).toHaveLength(1); // ONE line: the settings.update candidate
    expect(dispatcher).toMatch(/if \(p\.journal_day_log !== undefined\) candidate\['journal_day_log'\]/);
    expect(MATERIALIZED.test(dispatcher)).toBe(false);
  });

  it('adds no server job: the export composes logs, nothing writes them', () => {
    const jobs = readdirSync(path.join(repoRoot, 'apps/server/src/jobs'));
    expect(jobs.filter((f) => /day-?log/i.test(f))).toEqual([]);
    const exportJob = read('apps/server/src/jobs/journal-export.ts');
    // reads only — a day log is computed in memory and returned
    expect(exportJob).toMatch(/computeDayLogsByDate/);
    expect(exportJob).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });

  it('adds no sync stream table and no portability/purge registry entry', () => {
    expect(MATERIALIZED.test(read('packages/db/sync-streams.yaml'))).toBe(false);
    for (const rel of [
      'apps/server/src/jobs/backup-snapshot.ts',
      'apps/server/src/jobs/import-restore.ts',
      'apps/server/src/jobs/import-validate.ts',
    ]) {
      expect(MATERIALIZED.test(read(rel)), `${rel} must not know about a day-log table`).toBe(false);
    }
  });
});
