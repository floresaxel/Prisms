/**
 * M13 — client portability boundary (1.3 §13.1/§13.2): passphrase encryption,
 * on-disk (de)serialization + version gating, the import HLC-monotonicity floor,
 * and the secure-storage / db-encryption adapter ports.
 */
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  hlcCompareEncoded,
  type ExportManifest,
} from '@prisms/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createHlc,
  createMemorySecureStorage,
  createStaticDbEncryption,
  createWebSecureStorage,
  decryptExport,
  encryptExport,
  exportFilename,
  ImportFormatError,
  isEncryptedExport,
  loadImportedHlcFloor,
  noopDbEncryption,
  observeImportedHlc,
  parseImportFile,
  persistImportedHlc,
  serializeExport,
  __resetHlcFloorForTests,
} from '@prisms/ui';

const HIGH_WATER = 'ffffffffffff-000a-web-exporter';
const manifest: ExportManifest = {
  format: EXPORT_FORMAT,
  format_version: EXPORT_FORMAT_VERSION,
  schema_version: 1,
  exported_at: '2026-06-30T12:00:00.000Z',
  device_id: 'web-exporter',
  hlc_high_water: HIGH_WATER,
  tables: { nodes: [{ id: 'n1', title: 'Task', user_id: 'u1' }], user_settings: [] },
  command_history: [{ id: 'c1', name: 'node.rename' }],
};

afterEach(() => __resetHlcFloorForTests());

describe('export crypto (§13.1)', () => {
  it('encrypt → decrypt round-trips the plaintext', async () => {
    const env = await encryptExport('hello world', 'correct horse');
    expect(isEncryptedExport(env)).toBe(true);
    expect(env.ciphertext).not.toContain('hello');
    expect(await decryptExport(env, 'correct horse')).toBe('hello world');
  });

  it('a wrong passphrase fails authentication (never returns garbage)', async () => {
    const env = await encryptExport('secret', 'right');
    await expect(decryptExport(env, 'wrong')).rejects.toThrow(/wrong passphrase|decryption failed/i);
  });

  it('rejects an empty passphrase and a newer envelope version', async () => {
    await expect(encryptExport('x', '')).rejects.toThrow(/passphrase/i);
    const env = await encryptExport('x', 'p');
    await expect(decryptExport({ ...env, version: env.version + 1 }, 'p')).rejects.toThrow(/newer/i);
  });
});

describe('serialize / parse import file (§13.1)', () => {
  it('plaintext round-trips through serialize → parse', async () => {
    const text = await serializeExport(manifest);
    expect(isEncryptedExport(JSON.parse(text))).toBe(false);
    expect(await parseImportFile(text)).toEqual(manifest);
  });

  it('encrypted round-trips only with the passphrase', async () => {
    const text = await serializeExport(manifest, { passphrase: 'pw123' });
    expect(isEncryptedExport(JSON.parse(text))).toBe(true);
    await expect(parseImportFile(text)).rejects.toBeInstanceOf(ImportFormatError);
    await expect(parseImportFile(text, { passphrase: 'nope' })).rejects.toBeInstanceOf(ImportFormatError);
    expect(await parseImportFile(text, { passphrase: 'pw123' })).toEqual(manifest);
  });

  it('rejects garbage, a wrong format tag, and a newer format version (R11)', async () => {
    await expect(parseImportFile('{not json')).rejects.toBeInstanceOf(ImportFormatError);
    await expect(parseImportFile(JSON.stringify({ format: 'other', format_version: 1 }))).rejects.toBeInstanceOf(ImportFormatError);
    await expect(
      parseImportFile(JSON.stringify({ ...manifest, format_version: EXPORT_FORMAT_VERSION + 1 })),
    ).rejects.toThrow(/not supported/i);
  });

  it('exportFilename encodes the timestamp and encryption flag', () => {
    expect(exportFilename('2026-06-30T12:00:00.000Z', false)).toBe('prisms-export_2026-06-30_12-00-00-000.json');
    expect(exportFilename('2026-06-30T12:00:00.000Z', true)).toBe('prisms-export_2026-06-30_12-00-00-000.enc.json');
  });
});

describe('import HLC floor — monotonicity (§13.1, R20)', () => {
  it('a command minted after observing the high-water orders AFTER it', () => {
    observeImportedHlc(HIGH_WATER);
    const next = createHlc('web-importer')();
    expect(hlcCompareEncoded(next, HIGH_WATER)).toBe(1);
  });

  it('even a createHlc constructed BEFORE the import dominates once it observes', () => {
    const tick = createHlc('web-importer'); // constructed first
    observeImportedHlc(HIGH_WATER); // import happens mid-session
    expect(hlcCompareEncoded(tick(), HIGH_WATER)).toBe(1);
  });

  it('persist + reload re-observes the floor from storage', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    persistImportedHlc(HIGH_WATER, storage);
    expect(store.get('prisms.hlc_floor')).toBe(HIGH_WATER);

    // a fresh "session": clear the in-memory floor, then load from storage
    __resetHlcFloorForTests();
    loadImportedHlcFloor(storage);
    expect(hlcCompareEncoded(createHlc('web-importer')(), HIGH_WATER)).toBe(1);
  });
});

describe('adapter ports (§13.2/§13.3)', () => {
  it('web secure storage delegates to a Storage', async () => {
    const backing = new Map<string, string>();
    const ss = createWebSecureStorage({
      getItem: (k) => backing.get(k) ?? null,
      setItem: (k, v) => void backing.set(k, v),
      removeItem: (k) => void backing.delete(k),
    });
    await ss.set('k', 'v');
    expect(await ss.get('k')).toBe('v');
    await ss.delete('k');
    expect(await ss.get('k')).toBeNull();
  });

  it('memory secure storage seeds and round-trips', async () => {
    const ss = createMemorySecureStorage({ seeded: '1' });
    expect(await ss.get('seeded')).toBe('1');
    expect(await ss.get('missing')).toBeNull();
  });

  it('db-encryption port: noop is plaintext, static yields a key', async () => {
    expect(noopDbEncryption.enabled).toBe(false);
    expect(await noopDbEncryption.key()).toBeNull();
    const enc = createStaticDbEncryption('sqlcipher-key');
    expect(enc.enabled).toBe(true);
    expect(await enc.key()).toBe('sqlcipher-key');
  });
});
