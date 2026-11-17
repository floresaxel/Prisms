/**
 * What the service worker precaches (load plan, phase 4). The filter drops the
 * wa-sqlite builds this app never loads and must never drop anything it does:
 * a wrongly excluded file is an app that cannot open its database offline.
 */
import { describe, expect, it } from 'vitest';

import { UNUSED_SQLITE_ASSET } from '../vite.config';

describe('UNUSED_SQLITE_ASSET — the precache leaves out only SQLite builds nothing loads', () => {
  it.each([
    '/assets/mc-wa-sqlite-async-D6idQS2r.wasm',
    '/assets/mc-wa-sqlite-async-BfVNs7aC.js',
    '/assets/mc-wa-sqlite-CnHbhWvs.wasm',
    '/assets/mc-wa-sqlite-BfKEHAik.js',
    '/assets/wa-sqlite-XZW__iJk.wasm', // the SYNC build: only the OPFS VFSs load it
    '/assets/wa-sqlite-zCl4NM_R.js',
    '/assets/OPFSCoopSyncVFS-CHeKJICM.js',
    '/assets/OPFSWriteAheadVFS-BjJvMLxm.js',
    '/assets/AccessHandlePoolVFS-BzV9uQk3.js',
  ])('drops %s', (path) => {
    expect(UNUSED_SQLITE_ASSET.test(path)).toBe(true);
  });

  it.each([
    // what the default IndexedDB VFS with no encryption key actually runs
    '/assets/wa-sqlite-async-rHzzC98y.wasm',
    '/assets/wa-sqlite-async-DTVBqnCA.js',
    '/assets/IDBBatchAtomicVFS-CaPiKC1H.js',
    '/assets/FacadeVFS-3Vg_lAug.js',
    '/assets/WASQLiteDB.worker-DeL2QHpM.js',
    '/assets/SharedSyncImplementation.worker-nfGreNH-.js',
    // and everything else the app is made of
    '/assets/index-C8lAOBeA.js',
    '/assets/MyDay-AbCdEf12.js',
    '/assets/NoteSwap-Bhhf4CIj.js',
    '/assets/index-O-2FrS86.css',
    '/index.html',
  ])('keeps %s', (path) => {
    expect(UNUSED_SQLITE_ASSET.test(path)).toBe(false);
  });
});
