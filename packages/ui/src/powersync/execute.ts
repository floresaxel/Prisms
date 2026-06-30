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
 * `execute(name, payload)` is the generic writer over the full §8.1 catalog
 * (the optimistic effects come from `buildOptimisticEffects`); `renameNode` is a
 * thin convenience wrapper kept from the M0 slice. The id minting / HLC tick /
 * clock are injected so the harness is deterministic; the app passes the
 * browser-tier `newId` / `createHlc` defaults. Effects may be supplemented by the
 * caller (e.g. soft-delete closure, layout row-id resolution) via `extraEffects`.
 */
import {
  COMMAND_SCHEMAS,
  stripTrustFields,
  type ClientCommand,
  type CommandName,
  type OverlayEffect,
} from '@prisms/core';

import { createHlc, newId } from './client-runtime';
import { buildOptimisticEffects, type EffectSpec } from './effects';
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

/** Per-call overrides for verbs whose full effect set needs live state. */
export interface ExecuteOptions {
  /**
   * Effects to use INSTEAD of `buildOptimisticEffects` (for verbs whose target
   * row id isn't in the payload, e.g. layout upserts), or [] to skip the overlay.
   */
  effects?: EffectSpec[];
  /** Effects to APPEND to the built ones (e.g. the §I10 soft-delete closure). */
  extraEffects?: EffectSpec[];
}

export interface ExecuteCommand {
  /** Generic writer: validate → mint id/HLC → queue command + overlay effects. */
  execute(name: CommandName, payload: Record<string, unknown>, opts?: ExecuteOptions): Promise<string>;
  /** node.rename convenience wrapper (M0 slice). */
  renameNode(nodeId: string, title: string): Promise<string>;
}

export function createExecuteCommand(store: OverlayStore, ctx: ExecuteContext, deps: ExecuteDeps = {}): ExecuteCommand {
  const mintId = deps.mintId ?? newId;
  const nextHlc = deps.nextHlc ?? createHlc(ctx.deviceId);
  const now = deps.now ?? (() => new Date().toISOString());

  async function execute(name: CommandName, rawPayload: Record<string, unknown>, opts: ExecuteOptions = {}): Promise<string> {
    const payload = stripTrustFields(rawPayload);
    const parsed = COMMAND_SCHEMAS[name].safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new Error(`${name} invalid: ${first ? `${first.path.join('.') || 'payload'}: ${first.message}` : 'bad payload'}`);
    }

    const commandId = mintId();
    const hlc = nextHlc();
    const createdAt = now();

    const specs = opts.effects ?? buildOptimisticEffects(name, parsed.data, { userId: ctx.userId, deviceId: ctx.deviceId, now: createdAt });
    const allSpecs = [...specs, ...(opts.extraEffects ?? [])];
    const effects: OverlayEffect[] = allSpecs.map((s, seq) => ({
      command_id: commandId,
      hlc,
      table: s.table,
      row_id: s.row_id,
      op: s.op,
      fields: s.fields,
      seq,
    }));

    const command: ClientCommand = {
      id: commandId,
      name,
      hlc,
      payload: parsed.data as ClientCommand['payload'],
      status: 'pending',
      created_at: createdAt,
    };
    await store.enqueue(command, effects);
    return commandId;
  }

  return {
    execute,
    renameNode(nodeId, title) {
      return execute('node.rename', { id: nodeId, title });
    },
  };
}
