/**
 * M3 / §7.4 — `computed_aggregates` is server-owned: no command handler (and no
 * client upload path) may write it. The dispatcher is the only command write
 * path, so a static check that it never references the table proves the rule
 * (the runtime CHECK `computed_by = 'server'` is the DB backstop).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const dispatcherSrc = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dispatcher.ts'),
  'utf8',
);

describe('computed_aggregates is server-owned (§7.4)', () => {
  it('the command dispatcher never references computed_aggregates', () => {
    expect(dispatcherSrc).not.toMatch(/computed_aggregates/);
  });
});
