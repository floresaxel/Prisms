/**
 * Optimistic command writer for the two-layer store (1.3 §7.2, §7.2b–§7.2c).
 *
 * Replaces the v1.0 direct replica write (`db.execute('UPDATE nodes …')`) with:
 *   1. strip server-owned trust fields from the payload (§7.2c),
 *   2. validate against the catalog (the server re-validates authoritatively),
 *   3. mint the command id (UUIDv7) and tick the device HLC AT WRITE TIME (§7.2b)
 *      — not at upload, so `command_log.id` equals this id (V2),
 *   4. write `client_commands` + `overlay_effects` in ONE transaction (R15).
 *
 * M0 ships the `node.rename` slice; M8 generalizes to the full catalog. The id
 * minting / HLC tick / clock are injected so the spike harness is deterministic;
 * the app passes the browser-tier `newId` / `createHlc` defaults.
 */
import {
  COMMAND_SCHEMAS,
  buildRenameEffect,
  stripTrustFields,
  type ClientCommand,
} from '@prisms/core';

import { createHlc, newId } from './client-runtime';
import type { OverlayStore } from './overlay-store';

export interface ExecuteContext {
  userId: string;
  deviceId: string;
}

export interface ExecuteDeps {
  /** Mint a client command id (UUIDv7). Defaults to the browser-tier `newId`. */
  mintId?: () => string;
  /** Tick + encode the device HLC. Defaults to `createHlc(ctx.deviceId)`. */
  nextHlc?: () => string;
  /** ISO timestamp for the queued command. Defaults to wall clock. */
  now?: () => string;
}

export interface ExecuteCommand {
  /** node.rename (M0 slice): optimistic title update + queued command envelope. */
  renameNode(nodeId: string, title: string): Promise<string>;
}

export function createExecuteCommand(store: OverlayStore, ctx: ExecuteContext, deps: ExecuteDeps = {}): ExecuteCommand {
  const mintId = deps.mintId ?? newId;
  const nextHlc = deps.nextHlc ?? createHlc(ctx.deviceId);
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    async renameNode(nodeId, title) {
      const commandId = mintId();
      const hlc = nextHlc();
      const payload = stripTrustFields({ id: nodeId, title });

      const parsed = COMMAND_SCHEMAS['node.rename'].safeParse(payload);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new Error(`node.rename invalid: ${first ? `${first.path.join('.') || 'payload'}: ${first.message}` : 'bad payload'}`);
      }

      const command: ClientCommand = {
        id: commandId,
        name: 'node.rename',
        hlc,
        payload,
        status: 'pending',
        created_at: now(),
      };
      const effect = buildRenameEffect({ commandId, hlc, nodeId, title });
      await store.enqueue(command, [effect]);
      return commandId;
    },
  };
}
