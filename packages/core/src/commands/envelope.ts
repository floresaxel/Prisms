/**
 * Command envelope (§8): `POST /sync/upload` carries
 * `{ device_id, commands: [{ id, name, hlc, payload }] }`.
 *
 * The command id is client-generated (UUIDv7) and doubles as the idempotency
 * key; `hlc` orders same-field conflicts (§7.3). Payloads are parsed per-verb
 * by the catalog (`payloads.ts`, the full §8.1 set).
 */
import { z } from 'zod';

import {
  deviceIdSchema,
  hlcStringSchema,
  jsonValueSchema,
  uuidSchema,
} from '../domain/primitives';

export const commandEnvelopeSchema = z.strictObject({
  id: uuidSchema,
  name: z.string().min(1),
  hlc: hlcStringSchema,
  payload: jsonValueSchema,
  /** Command-payload version (§8); server migrates or rejects an old payload. */
  command_version: z.number().int().positive().optional(),
  /** Row schema version the client writes at (§7.11); below the floor → client_too_old. */
  schema_version: z.number().int().nonnegative().optional(),
  /** Free-form client build tag, for diagnostics + version-specific review items. */
  client_version: z.string().optional(),
  /** Intra-device causal dependencies (§7.2e): command ids this one builds on. */
  depends_on: z.array(uuidSchema).optional(),
});
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

export const uploadRequestSchema = z.strictObject({
  device_id: deviceIdSchema,
  commands: z.array(commandEnvelopeSchema).min(1).max(100),
});
export type UploadRequest = z.infer<typeof uploadRequestSchema>;

/**
 * Per-command outcome — the frozen `uploadData` response contract (§8 step 5).
 * The shape the convergence harness (M7) asserts and the client (M8) parses to
 * reconcile its overlay.
 */
export const commandOutcomeSchema = z.strictObject({
  id: uuidSchema,
  result: z.enum(['applied', 'rejected', 'noop']),
  /** For noop replays: what the original execution returned. */
  original_result: z.enum(['applied', 'rejected']).optional(),
  reject_code: z.string().optional(),
  reject_reason: z.string().optional(),
  /**
   * On `applied`: the provenance id the server stamped on created/updated rows
   * (equals the command id, §7.2b). The optimistic overlay predicted this, so
   * the synced-down row keeps its identity on reconciliation.
   */
  created_by_command_id: uuidSchema.optional(),
  /** Ids of any sync_review_items this command produced (§7.13). */
  review_item_ids: z.array(uuidSchema).optional(),
  /**
   * On `applied` (D5): the authoritative rows this command wrote, as
   * `{table, row_id, op}`. When a `row_id` differs from the client's optimistic
   * effect (two offline devices minted different ids for the SAME new row, e.g. a
   * journal day), the client rewrites its overlay effect to the server's id so it
   * reconciles instead of leaving a ghost. Absent ⇒ old server; behavior unchanged.
   */
  effects: z
    .array(z.strictObject({ table: z.string(), row_id: uuidSchema, op: z.enum(['insert', 'update', 'delete']) }))
    .optional(),
});
export type CommandOutcome = z.infer<typeof commandOutcomeSchema>;
