/**
 * Client import/export orchestration (1.3 §13.1, M13). Turns an `ExportManifest`
 * into the text written to a file (optionally passphrase-encrypted) and back —
 * validating the format + version on the way in. The manifest itself is produced
 * by the server `backup.snapshot` job and RESTORED by the server import txn; this
 * module is the on-disk (de)serialization + the HLC monotonicity handoff.
 *
 * Pure of the DOM (Blob/download live in the app) so it unit-tests in node.
 */
import { exportManifestSchema, isSupportedExportVersion, type ExportManifest } from '@prisms/core';

import { decryptExport, encryptExport, isEncryptedExport } from './crypto';

export interface SerializeOptions {
  /** When set, the file is AES-GCM encrypted under this passphrase (§13.1). */
  passphrase?: string;
  /** Pretty-print the JSON (default true for a hand-inspectable plaintext export). */
  pretty?: boolean;
}

/** Manifest → the exact text to write to a `.json` (plaintext) or `.enc.json` (encrypted) file. */
export async function serializeExport(manifest: ExportManifest, opts: SerializeOptions = {}): Promise<string> {
  const json = JSON.stringify(manifest, null, opts.pretty === false ? undefined : 2);
  if (opts.passphrase && opts.passphrase.length > 0) {
    const env = await encryptExport(json, opts.passphrase);
    return JSON.stringify(env, null, 2);
  }
  return json;
}

export interface ParseOptions {
  /** Required when the file is an encrypted envelope; ignored for plaintext. */
  passphrase?: string;
}

export class ImportFormatError extends Error {}

/**
 * File text → a validated `ExportManifest`. Decrypts an encrypted envelope (needs
 * the passphrase), rejects a newer-than-supported format version explicitly (R11),
 * and validates the manifest shape. Throws `ImportFormatError` on any bad input.
 */
export async function parseImportFile(text: string, opts: ParseOptions = {}): Promise<ExportManifest> {
  let outer: unknown;
  try {
    outer = JSON.parse(text);
  } catch {
    throw new ImportFormatError('file is not valid JSON');
  }

  let manifestJson: unknown = outer;
  if (isEncryptedExport(outer)) {
    if (!opts.passphrase || opts.passphrase.length === 0) {
      throw new ImportFormatError('this export is encrypted — enter its passphrase to import it');
    }
    let plain: string;
    try {
      plain = await decryptExport(outer, opts.passphrase);
    } catch (e) {
      throw new ImportFormatError(e instanceof Error ? e.message : 'decryption failed');
    }
    try {
      manifestJson = JSON.parse(plain);
    } catch {
      throw new ImportFormatError('decrypted content is not valid JSON');
    }
  }

  const version = (manifestJson as { format_version?: unknown }).format_version;
  if (typeof version === 'number' && !isSupportedExportVersion(version)) {
    throw new ImportFormatError(`export format version ${version} is not supported by this app`);
  }

  const parsed = exportManifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ImportFormatError(
      `not a valid prisms-export: ${first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'bad manifest'}`,
    );
  }
  return parsed.data;
}

/** A stable, sortable export filename for a download. `at` is an ISO timestamp. */
export function exportFilename(at: string, encrypted: boolean): string {
  const stamp = at.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  return `prisms-export_${stamp}${encrypted ? '.enc' : ''}.json`;
}
