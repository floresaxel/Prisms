// @vitest-environment jsdom
/**
 * One open database per account, and the boot opening it early.
 *
 * `early-open.ts` creates the remembered account's database before React runs;
 * the app must pick up THAT instance, not open the same file a second time
 * (nor may StrictMode's double render). `@powersync/web` is mocked to count
 * constructions, as in logout-boundary.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installMemoryStorage } from './util/memory-storage';

const opened = vi.hoisted(() => ({ files: [] as string[] }));
vi.mock('@powersync/web', () => ({
  PowerSyncDatabase: class {
    constructor(opts: { database: { dbFilename: string } }) {
      opened.files.push(opts.database.dbFilename);
    }
  },
}));

// Each test gets fresh modules: the registry is module state, and early-open
// does its work on import.
beforeEach(() => {
  vi.resetModules();
  opened.files.length = 0;
  installMemoryStorage();
});

describe('dbFor — one database per account', () => {
  it('hands back the same instance for the same account, however often it is asked', async () => {
    const { dbFor } = await import('../src/powersync');
    const first = dbFor('alice');
    expect(dbFor('alice')).toBe(first);
    expect(dbFor('alice')).toBe(first);
    expect(opened.files).toEqual(['prisms-alice.db']);
  });

  it('keeps accounts apart — each its own per-account file (S9-F1)', async () => {
    const { dbFor } = await import('../src/powersync');
    expect(dbFor('alice')).not.toBe(dbFor('bob'));
    expect(opened.files).toEqual(['prisms-alice.db', 'prisms-bob.db']);
  });

  it('after forgetDb, the next ask builds a fresh instance (what sign-out wants)', async () => {
    const { dbFor, forgetDb } = await import('../src/powersync');
    const before = dbFor('alice');
    forgetDb('alice');
    const after = dbFor('alice');
    expect(after).not.toBe(before);
    expect(opened.files).toEqual(['prisms-alice.db', 'prisms-alice.db']);
  });
});

describe('early-open — the remembered account’s database starts opening at load', () => {
  it('opens it on import, and the app’s later ask gets that same instance', async () => {
    const { rememberUser } = await import('../src/session-boot');
    rememberUser({ id: 'alice', email: 'a@prisms.test', name: 'A' });

    await import('../src/early-open');
    expect(opened.files).toEqual(['prisms-alice.db']); // before any React, before any session check

    const { dbFor } = await import('../src/powersync');
    dbFor('alice');
    expect(opened.files).toEqual(['prisms-alice.db']); // picked up, not opened twice
  });

  it('opens nothing when nobody is remembered (a first visit waits for sign-in)', async () => {
    await import('../src/early-open');
    expect(opened.files).toEqual([]);
  });

  it('opens nothing for a corrupt remembered entry', async () => {
    localStorage.setItem('prisms.user', '{"id":');
    await import('../src/early-open');
    expect(opened.files).toEqual([]);
  });
});
