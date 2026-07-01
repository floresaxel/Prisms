/**
 * M1 — portable export/import manifest schemas (1.3 §13.1).
 */
import { describe, expect, it } from 'vitest';

import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  exportManifestSchema,
  importReportSchema,
  importSourceDetail,
  isSupportedExportVersion,
} from '../../src/sync/manifest';

const validManifest = {
  format: EXPORT_FORMAT,
  format_version: EXPORT_FORMAT_VERSION,
  schema_version: 1,
  exported_at: '2026-06-27T00:00:00.000Z',
  device_id: 'web-1',
  hlc_high_water: '000000000abc-0001-web-1',
  tables: { nodes: [{ id: 'n1', title: 'T' }], user_settings: [] },
  command_history: [{ id: 'c1', name: 'node.rename' }],
};

describe('exportManifestSchema', () => {
  it('accepts a well-formed manifest', () => {
    expect(exportManifestSchema.safeParse(validManifest).success).toBe(true);
  });

  it('command_history is optional (a settings-only export is valid)', () => {
    const { command_history, ...rest } = validManifest;
    void command_history;
    expect(exportManifestSchema.safeParse(rest).success).toBe(true);
  });

  it('rejects the wrong format tag or a malformed high-water HLC', () => {
    expect(exportManifestSchema.safeParse({ ...validManifest, format: 'other' }).success).toBe(false);
    expect(exportManifestSchema.safeParse({ ...validManifest, hlc_high_water: 'nope' }).success).toBe(false);
  });

  it('rejects an unknown top-level key (strict)', () => {
    expect(exportManifestSchema.safeParse({ ...validManifest, secret: 'leak' }).success).toBe(false);
  });
});

describe('isSupportedExportVersion (R11)', () => {
  it('accepts 1..current and rejects a newer or non-positive version', () => {
    expect(isSupportedExportVersion(1)).toBe(true);
    expect(isSupportedExportVersion(EXPORT_FORMAT_VERSION)).toBe(true);
    expect(isSupportedExportVersion(EXPORT_FORMAT_VERSION + 1)).toBe(false);
    expect(isSupportedExportVersion(0)).toBe(false);
    expect(isSupportedExportVersion(1.5)).toBe(false);
  });
});

describe('importSourceDetail (§7.8/§13.1)', () => {
  it('captures the source export so imported rows explain themselves', () => {
    const d = importSourceDetail({ device_id: 'web-1', exported_at: '2026-06-30T00:00:00.000Z', format_version: 1 });
    expect(d).toMatchObject({ imported: true, imported_from_device: 'web-1', export_format_version: 1 });
  });
});

describe('importReportSchema', () => {
  it('accepts a dry-run report with conflicts and warnings', () => {
    const report = {
      format_ok: true,
      row_counts: { nodes: 3 },
      conflicts: [{ table: 'nodes', id: 'n1', reason: 'hlc older than canonical' }],
      warnings: ['2 rows skipped'],
    };
    expect(importReportSchema.safeParse(report).success).toBe(true);
  });
});
