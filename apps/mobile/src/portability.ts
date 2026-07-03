/**
 * Mobile export (§13.1, V12; M14). Installed targets export ENCRYPTED BY DEFAULT,
 * so a passphrase is required. The manifest comes from the server backup.snapshot
 * endpoint; serialization + AES-GCM encryption are the shared @prisms/ui helpers;
 * the file is handed off through React Native's built-in Share sheet (no extra
 * native dependency). Import (a document picker) is deferred — do it on web/desktop.
 */
import type { ExportManifest } from '@prisms/core';
import { serializeExport } from '@prisms/ui';
import { Share } from 'react-native';

import { config } from './config';

/** GET the portable export manifest for the signed-in user. */
export async function fetchExport(): Promise<ExportManifest> {
  const res = await fetch(`${config.apiBaseUrl}/sync/export`, { credentials: 'include' });
  if (!res.ok) throw new Error(`export failed (${res.status})`);
  return (await res.json()) as ExportManifest;
}

/**
 * Fetch, encrypt (required on installed targets), and share the export. Throws
 * if no passphrase is given — plaintext export is not offered on mobile (§13.1).
 */
export async function exportAndShare(passphrase: string): Promise<void> {
  if (passphrase.length === 0) throw new Error('a passphrase is required to export on this device');
  const manifest = await fetchExport();
  const text = await serializeExport(manifest, { passphrase });
  await Share.share({ title: 'Prisms encrypted export', message: text });
}
