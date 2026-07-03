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
import type { OverlayStore, PendingCommand } from './overlay-store';

interface CommandResult {
  id: string;
  result: 'applied' | 'rejected' | 'noop';
  reject_code?: string;
  reject_reason?: string;
}
interface UploadResult {
  results?: CommandResult[];
}

/**
 * Max commands per upload request — matches `uploadRequestSchema`'s server cap
 * (§7.2). A device offline long enough to queue more than this is split into
 * sequential batches (HLC order preserved) so it never trips the limit (S7-F2).
 */
export const MAX_UPLOAD_BATCH = 100;

/**
 * A 4xx from the server: the request is malformed (bad envelope, too large) and
 * will NOT succeed by retrying. Distinguished from transient network/5xx/429 so
 * the driver can surface it loudly instead of retry-looping silently (S7-F2).
 */
export class UploadClientError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
  ) {
    super(`upload rejected by server (${status})`);
    this.name = 'UploadClientError';
  }
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

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The envelope body for one command — id/hlc/versions preserved verbatim (V2). */
function toEnvelope(c: PendingCommand) {
  return {
    id: c.id,
    name: c.name,
    hlc: c.hlc,
    payload: c.payload,
    // command_version/schema_version always sent so the server can enforce the
    // §7.11 floor; depends_on/client_version only when set (strict envelope).
    command_version: c.command_version,
    schema_version: c.schema_version,
    ...(c.client_version ? { client_version: c.client_version } : {}),
    ...(c.depends_on.length ? { depends_on: [...c.depends_on] } : {}),
  };
}

export async function uploadClientCommands(options: UploadCommandsOptions): Promise<UploadSummary> {
  const { store, apiBaseUrl, deviceId } = options;
  const doFetch = options.fetch ?? fetch;

  // First drop any overlay whose canonical row has already synced down (and prune
  // long-dead rejected rows) — this also runs when the queue is empty, so applied
  // commands reconcile on each drain even after the queue drains (S7-F6/F9).
  await store.reconcileConfirmed();

  const commands = await store.pendingCommands();
  const summary: UploadSummary = { uploaded: commands.length, applied: 0, rejected: 0, noop: 0 };
  if (commands.length === 0) return summary;

  const rejections: CommandRejection[] = [];

  // Sequential ≤100-command batches, HLC order preserved (S7-F2).
  for (const batch of chunk(commands, MAX_UPLOAD_BATCH)) {
    const res = await doFetch(`${apiBaseUrl}/sync/upload`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', origin: apiBaseUrl },
      // preserve the stored id + hlc + version axes verbatim — no upload-time minting (V2).
      body: JSON.stringify({ device_id: deviceId, commands: batch.map(toEnvelope) }),
    });
    if (!res.ok) {
      // 4xx (except 429): the request itself is bad — retrying can't fix it.
      // Surface loudly. 429 (rate-limited) is transient, so it retries like 5xx.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const bodyText = await res.text().catch(() => '');
        throw new UploadClientError(res.status, bodyText);
      }
      // 5xx / 429 / network: transient — throw so the queue survives + retries.
      throw new Error(`upload failed: ${res.status}`);
    }

    const body = (await res.json()) as UploadResult;
    const byId = new Map((body.results ?? []).map((r) => [r.id, r]));
    for (const command of batch) {
      const result = byId.get(command.id);
      if (!result) continue; // server omitted it — leave pending, retry next sync.
      if (result.result === 'rejected') {
        // drop the overlay (rollback); the server-created review item syncs down (§7.13).
        await store.rollbackRejected({ commandId: command.id, rejectCode: result.reject_code, rejectReason: result.reject_reason });
        rejections.push({ id: command.id, name: command.name, reject_code: result.reject_code, reject_reason: result.reject_reason });
        summary.rejected += 1;
      } else {
        // applied | noop: mark applied but KEEP the overlay until the canonical
        // row arrives (reconcileConfirmed drops it) — no revert-flicker (S7-F6).
        await store.markApplied(command.id);
        if (result.result === 'noop') summary.noop += 1;
        else summary.applied += 1;
      }
    }
  }

  if (rejections.length > 0) options.onReject?.(rejections);
  return summary;
}
