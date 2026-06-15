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
});
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

export const uploadRequestSchema = z.strictObject({
  device_id: deviceIdSchema,
  commands: z.array(commandEnvelopeSchema).min(1).max(100),
});
export type UploadRequest = z.infer<typeof uploadRequestSchema>;

/** Per-command outcome, §8 pipeline step 5. */
export const commandOutcomeSchema = z.strictObject({
  id: uuidSchema,
  result: z.enum(['applied', 'rejected', 'noop']),
  /** For noop replays: what the original execution returned. */
  original_result: z.enum(['applied', 'rejected']).optional(),
  reject_code: z.string().optional(),
  reject_reason: z.string().optional(),
});
export type CommandOutcome = z.infer<typeof commandOutcomeSchema>;
