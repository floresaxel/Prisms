/**
 * The two-layer upload path (1.3 §7.2): uploads named command envelopes read
 * from `client_commands` — NOT PowerSync CRUD row patches. Each command keeps
 * the id + HLC it was minted with at write time (kills the v1.0
 * `newId()`-at-upload, so `command_log.id` equals the client id — V2). On the
 * server response:
 *   - `applied` / `noop` → drop the overlay; the identical canonical row syncs
 *     back down and carries the change (overlay reconciliation),
 *   - `rejected` → drop the overlay (rollback) + record a `sync_review_items`
 *     row bound to the command id (§7.13).
 *
 * Network / 429 throws so the queue is retried (commands stay `pending`).
 *
 * M0 wires this as an additive path alongside the existing CRUD connector; M8
 * makes it the connector's only `uploadData` and deletes the CRUD bridge.
 */
import type { CommandRejection } from './connector';
import type { OverlayStore } from './overlay-store';

interface CommandResult {
  id: string;
  result: 'applied' | 'rejected' | 'noop';
  reject_code?: string;
  reject_reason?: string;
}
interface UploadResult {
  results?: CommandResult[];
}

export interface UploadCommandsOptions {
  store: OverlayStore;
  apiBaseUrl: string;
  deviceId: string;
  fetch?: typeof fetch;
  /** Surface rejected commands to the UI (the overlay has already rolled back). */
  onReject?: (rejections: CommandRejection[]) => void;
}

export interface UploadSummary {
  uploaded: number;
  applied: number;
  rejected: number;
  noop: number;
}

export async function uploadClientCommands(options: UploadCommandsOptions): Promise<UploadSummary> {
  const { store, apiBaseUrl, deviceId } = options;
  const doFetch = options.fetch ?? fetch;

  const commands = await store.pendingCommands();
  const summary: UploadSummary = { uploaded: commands.length, applied: 0, rejected: 0, noop: 0 };
  if (commands.length === 0) return summary;

  const res = await doFetch(`${apiBaseUrl}/sync/upload`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', origin: apiBaseUrl },
    // preserve the stored id + hlc verbatim — no upload-time minting (V2).
    body: JSON.stringify({
      device_id: deviceId,
      commands: commands.map((c) => ({ id: c.id, name: c.name, hlc: c.hlc, payload: c.payload })),
    }),
  });
  // network / 429: throw so the queue survives and retries.
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);

  const body = (await res.json()) as UploadResult;
  const byId = new Map((body.results ?? []).map((r) => [r.id, r]));
  const rejections: CommandRejection[] = [];

  for (const command of commands) {
    const result = byId.get(command.id);
    if (!result) continue; // server omitted it — leave pending, retry next sync.
    if (result.result === 'rejected') {
      // drop the overlay (rollback); the server-created review item syncs down (§7.13).
      await store.rollbackRejected({ commandId: command.id, rejectCode: result.reject_code, rejectReason: result.reject_reason });
      rejections.push({ id: command.id, name: command.name, reject_code: result.reject_code, reject_reason: result.reject_reason });
      summary.rejected += 1;
    } else {
      // applied | noop: the identical canonical row carries the change.
      await store.reconcileApplied(command.id);
      if (result.result === 'noop') summary.noop += 1;
      else summary.applied += 1;
    }
  }

  if (rejections.length > 0) options.onReject?.(rejections);
  return summary;
}
