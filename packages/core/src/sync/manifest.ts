/**
 * Portable export/import manifest schemas (1.3 §13.1, R20). PURE (§16).
 * M1 defines the wire shapes; M6 (`import.validate`/`backup.snapshot`) and M13
 * (client import/export) consume them.
 *
 * Import RESTORES rows as data — it does NOT replay command history. The export
 * carries a high-water HLC so an importer advances its clock past it and HLC
 * monotonicity is preserved. Secrets (auth/provider) are never exported.
 */
import { deviceIdSchema, hlcStringSchema, isoDateTimeSchema, jsonObjectSchema } from '../domain/primitives';
import { z } from 'zod';

export const EXPORT_FORMAT = 'prisms-export';
export const EXPORT_FORMAT_VERSION = 1;

/**
 * A versioned portable export. `tables` is rows-as-data keyed by table name;
 * `command_history` is included for recoverability but is non-replayable.
 */
export const exportManifestSchema = z.strictObject({
  format: z.literal(EXPORT_FORMAT),
  format_version: z.number().int().positive(),
  schema_version: z.number().int().nonnegative(),
  exported_at: isoDateTimeSchema,
  device_id: deviceIdSchema,
  /** Max HLC in the export; an importer advances its clock past this (monotonicity). */
  hlc_high_water: hlcStringSchema,
  tables: z.record(z.string(), z.array(jsonObjectSchema)),
  command_history: z.array(jsonObjectSchema).optional(),
});
export type ExportManifest = z.infer<typeof exportManifestSchema>;

/** A single conflict surfaced by a dry-run import (becomes an import_warning, §7.13). */
export const importConflictSchema = z.strictObject({
  table: z.string(),
  id: z.string(),
  reason: z.string(),
});
export type ImportConflict = z.infer<typeof importConflictSchema>;

/** The dry-run import validation report (§13.1; M6 `import.validate`). */
export const importReportSchema = z.strictObject({
  format_ok: z.boolean(),
  row_counts: z.record(z.string(), z.number().int().nonnegative()),
  conflicts: z.array(importConflictSchema),
  warnings: z.array(z.string()),
});
export type ImportReport = z.infer<typeof importReportSchema>;
