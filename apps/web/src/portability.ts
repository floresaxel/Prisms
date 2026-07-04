/**
 * Web import/export wiring (§13.1, M13). Talks to the server export/import
 * endpoints (cookie-authed, same-origin via the Vite proxy) and hands the
 * on-disk (de)serialization + passphrase encryption to `@prisms/ui`. After a
 * successful restore it advances the device HLC floor so subsequent local edits
 * order after the imported state (monotonicity, R20).
 */
import type { ExportManifest, ImportReport } from '@prisms/core';
import { buildJournalArchive, journalArchiveFilename, parseImportFile, persistImportedHlc, serializeExport, exportFilename } from '@prisms/ui';

import { config } from './config';

const api = config.apiBaseUrl;

/** Server restore result (mirrors apps/server import-restore ImportRestoreResult). */
export interface ImportRestoreResult {
  ok: boolean;
  restored: Record<string, number>;
  conflicts: { table: string; id: string; reason: string }[];
  warnings: string[];
  reviewItemIds: string[];
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok && res.status !== 400) throw new Error(`request failed (${res.status})`);
  return res.json();
}

/** GET the portable export manifest for the signed-in user. */
export async function fetchExport(): Promise<ExportManifest> {
  const res = await fetch(`${api}/sync/export`, { credentials: 'include' });
  if (!res.ok) throw new Error(`export failed (${res.status})`);
  return (await res.json()) as ExportManifest;
}

/** Serialize (optionally encrypt) a manifest and trigger a browser download. */
export async function downloadExport(manifest: ExportManifest, passphrase?: string): Promise<string> {
  const text = await serializeExport(manifest, passphrase ? { passphrase } : {});
  const name = exportFilename(manifest.exported_at, Boolean(passphrase));
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return name;
}

/** Parse a file's text (decrypting if needed) into a validated manifest. */
export function readImportFile(text: string, passphrase?: string): Promise<ExportManifest> {
  return parseImportFile(text, passphrase ? { passphrase } : {});
}

/** Dry-run an import — the server reports conflicts/warnings and writes no data. */
export async function dryRunImport(manifest: ExportManifest): Promise<ImportReport> {
  const res = await fetch(`${api}/sync/import?dry_run=1`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  return (await jsonOrThrow(res)) as ImportReport;
}

/**
 * Restore an import (writes rows as data server-side, syncs down), then advance
 * the device HLC floor past the imported high-water so later edits order after it.
 */
export async function restoreImport(manifest: ExportManifest): Promise<ImportRestoreResult> {
  const res = await fetch(`${api}/sync/import`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  const result = (await jsonOrThrow(res)) as ImportRestoreResult;
  if (result.ok) persistImportedHlc(manifest.hlc_high_water);
  return result;
}

/** A journal note as the D7 export endpoint returns it. */
export interface JournalExportRow {
  entry_date: string;
  content: string;
  updated_at: string;
}

/**
 * GET all of the user's live journal notes (D7). SERVER-sourced — never the local
 * replica — because under lazy month sync a device may hold only viewed months, so
 * a local "export all" would silently truncate.
 */
export async function fetchJournalExport(): Promise<JournalExportRow[]> {
  const res = await fetch(`${api}/sync/journal/export`, { credentials: 'include' });
  if (!res.ok) throw new Error(`journal export failed (${res.status})`);
  return ((await res.json()) as { entries: JournalExportRow[] }).entries;
}

/** Fetch all notes, build the per-day `.md` zip, and trigger a browser download. */
export async function downloadJournalArchive(): Promise<string> {
  const entries = await fetchJournalExport();
  const name = journalArchiveFilename(new Date().toISOString());
  // Copy into a fresh Uint8Array (plain ArrayBuffer) so it satisfies BlobPart (TS 5.7 variance).
  const blob = new Blob([new Uint8Array(buildJournalArchive(entries))], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return name;
}
