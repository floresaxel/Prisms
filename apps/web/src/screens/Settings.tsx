/**
 * Settings (§6.0 user_settings): the configurable day-reset hour + timezone
 * that drive every "today/daily" computation (§7.2). Writes settings.update;
 * a fresh account has no row yet, so the first save inserts one (id = user_id,
 * which the server upserts on).
 */
import { useEffect, useRef, useState } from 'react';

import type { ImportReport } from '@prisms/core';
import { useCommands, useUserSettings, type CommandContext } from '@prisms/ui';

import { downloadExport, dryRunImport, fetchExport, readImportFile, restoreImport } from '../portability';

export function Settings({ ctx }: { ctx: CommandContext }) {
  // §7.14: settings come from the warm shared read layer, not a screen-local
  // subscription (user_settings is provider-owned). hasRow drives insert vs update.
  const settings = useUserSettings();
  const commands = useCommands(ctx);
  const hasRow = settings.hasRow;

  const [hour, setHour] = useState(String(settings.dayResetHour));
  const [tz, setTz] = useState(settings.timezone);
  const [saved, setSaved] = useState(false);

  // keep inputs in sync if settings arrive after mount
  useEffect(() => {
    setHour(String(settings.dayResetHour));
    setTz(settings.timezone);
  }, [settings.dayResetHour, settings.timezone]);

  async function save() {
    const day_reset_hour = Math.min(23, Math.max(0, Number(hour) || 0));
    const timezone = tz.trim() || 'America/New_York';
    if (hasRow) await commands.updateSettings({ day_reset_hour, timezone });
    else await commands.insertSettings({ day_reset_hour, timezone });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <section>
      <h1>Settings</h1>
      <p className="px-muted">The day-reset hour and timezone define when your day flips (§7.2).</p>

      <label className="px-field" style={{ maxWidth: 320 }}>
        Day-reset hour (0–23)
        <input className="px-input" type="number" min={0} max={23} data-testid="settings-hour" value={hour} onChange={(e) => setHour(e.target.value)} />
      </label>
      <label className="px-field" style={{ maxWidth: 320 }}>
        Timezone (IANA)
        <input className="px-input" data-testid="settings-tz" value={tz} onChange={(e) => setTz(e.target.value)} />
      </label>
      <button className="px-btn px-btn--primary" data-testid="settings-save" onClick={() => void save()}>Save</button>
      {saved && <span className="px-muted" data-testid="settings-saved" style={{ marginLeft: 10 }}>Saved ✓</span>}

      <Portability />
    </section>
  );
}

/**
 * Backup / restore (§13.1): download a portable, optionally passphrase-encrypted
 * export of all your data; import one with a dry-run preview before restoring. On
 * web, encryption is opt-in and the replica is not encrypted at rest (§13.2) —
 * installed apps default to encrypted export (M14).
 */
function Portability() {
  const [exportPass, setExportPass] = useState('');
  const [importPass, setImportPass] = useState('');
  const [fileText, setFileText] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onExport() {
    setBusy(true);
    setStatus(null);
    try {
      const manifest = await fetchExport();
      const name = await downloadExport(manifest, exportPass || undefined);
      setStatus(`Exported ${name}${exportPass ? ' (encrypted)' : ''}`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'export failed');
    } finally {
      setBusy(false);
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setReport(null);
    setStatus(null);
    if (!file) {
      setFileText(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setFileText(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsText(file);
  }

  async function onValidate() {
    if (fileText === null) return;
    setBusy(true);
    setStatus(null);
    setReport(null);
    try {
      const manifest = await readImportFile(fileText, importPass || undefined);
      setReport(await dryRunImport(manifest));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'could not read the file');
    } finally {
      setBusy(false);
    }
  }

  async function onRestore() {
    if (fileText === null) return;
    setBusy(true);
    setStatus(null);
    try {
      const manifest = await readImportFile(fileText, importPass || undefined);
      const result = await restoreImport(manifest);
      if (!result.ok) {
        setStatus(`Import rejected: ${result.warnings[0] ?? 'unsupported file'}`);
      } else {
        const total = Object.values(result.restored).reduce((a, b) => a + b, 0);
        setStatus(`Restored ${total} row(s)${result.conflicts.length ? `, ${result.conflicts.length} conflict(s) → see Review` : ''}. Syncing…`);
        setReport(null);
        setFileText(null);
        if (fileRef.current) fileRef.current.value = '';
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'import failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="portability" style={{ marginTop: 36, borderTop: '1px solid var(--px-border)', paddingTop: 20 }}>
      <h2>Backup &amp; restore</h2>
      <p className="px-muted">Export all your data to a file, or import a previous export. Import restores data — it never re-runs your history.</p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 20 }}>
        <input
          className="px-input"
          type="password"
          placeholder="passphrase (optional — encrypts the file)"
          data-testid="export-passphrase"
          value={exportPass}
          onChange={(e) => setExportPass(e.target.value)}
          style={{ minWidth: 280 }}
        />
        <button className="px-btn px-btn--primary" data-testid="export-download" disabled={busy} onClick={() => void onExport()}>
          Download export
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input ref={fileRef} type="file" accept=".json,application/json" data-testid="import-file" onChange={onFile} />
        <input
          className="px-input"
          type="password"
          placeholder="passphrase (if encrypted)"
          data-testid="import-passphrase"
          value={importPass}
          onChange={(e) => setImportPass(e.target.value)}
          style={{ minWidth: 200 }}
        />
        <button className="px-btn" data-testid="import-validate" disabled={busy || fileText === null} onClick={() => void onValidate()}>
          Validate
        </button>
        <button className="px-btn px-btn--danger" data-testid="import-restore" disabled={busy || fileText === null} onClick={() => void onRestore()}>
          Restore
        </button>
      </div>

      {report && (
        <div className="px-muted" data-testid="import-report" style={{ marginTop: 12, fontSize: 13 }}>
          {report.format_ok ? (
            <>
              Dry run: {Object.values(report.row_counts).reduce((a, b) => a + b, 0)} row(s) across {Object.keys(report.row_counts).length} table(s);{' '}
              <span data-testid="import-conflicts">{report.conflicts.length}</span> conflict(s), {report.warnings.length} warning(s).
            </>
          ) : (
            <>Not a valid export file.</>
          )}
        </div>
      )}
      {status && <div className="px-muted" data-testid="portability-status" style={{ marginTop: 10 }}>{status}</div>}
    </div>
  );
}
