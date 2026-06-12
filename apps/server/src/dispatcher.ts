/**
 * Command dispatcher — the §8 pipeline, wired for settings.update (s10).
 * TODO(s11): full catalog, core invariant checks, HLC LWW for general
 * per-field patches.
 *
 * Pipeline per command: (1) Zod parse → (2) ownership (settings rows are
 * keyed by the session user; the payload cannot name another user) →
 * (3) invariants (schema ranges) → (4) apply via Drizzle in a transaction →
 * (5) append command_log. The command id is the idempotency key: replays
 * return `noop` with the original result. Rejections are logged too, so a
 * replayed rejection is also a noop.
 */
import {
  SETTINGS_UPDATE,
  settingsUpdateSchema,
  uploadRequestSchema,
  type CommandEnvelope,
  type CommandOutcome,
} from '@prisms/core';
import { command_log, user_settings } from '@prisms/db';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import type { RateLimiter } from './rate-limit';

export type UploadResponse =
  | { kind: 'parse_error'; issues: unknown }
  | { kind: 'rate_limited'; verb: string; retryAfterSeconds: number }
  | { kind: 'ok'; results: CommandOutcome[] };

export interface Dispatcher {
  handleUpload(userId: string, body: unknown): Promise<UploadResponse>;
}

export function createDispatcher(
  db: PostgresJsDatabase,
  limiter: RateLimiter,
  nowIso: () => string = () => new Date().toISOString(),
): Dispatcher {
  async function logRejection(
    userId: string,
    deviceId: string,
    cmd: CommandEnvelope,
    code: string,
    reason: string,
  ): Promise<CommandOutcome> {
    await db.insert(command_log).values({
      id: cmd.id,
      user_id: userId,
      name: cmd.name,
      payload: cmd.payload,
      device_id: deviceId,
      hlc: cmd.hlc,
      result: 'rejected',
      reject_reason: `${code}: ${reason}`,
    });
    return { id: cmd.id, result: 'rejected', reject_code: code, reject_reason: reason };
  }

  async function applySettingsUpdate(
    userId: string,
    deviceId: string,
    cmd: CommandEnvelope,
  ): Promise<CommandOutcome> {
    const parsed = settingsUpdateSchema.safeParse(cmd.payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const reason = first
        ? `${first.path.join('.') || 'payload'}: ${first.message}`
        : 'invalid payload';
      return logRejection(userId, deviceId, cmd, 'E_PARSE', reason);
    }

    // Minimal-field patch (§2.8): write exactly the provided fields.
    const patch = parsed.data;
    const ts = nowIso();
    const insertValues: typeof user_settings.$inferInsert = {
      user_id: userId,
      updated_at: ts,
    };
    const set: Partial<typeof user_settings.$inferInsert> = { updated_at: ts };
    if (patch.day_reset_hour !== undefined) {
      insertValues.day_reset_hour = patch.day_reset_hour;
      set.day_reset_hour = patch.day_reset_hour;
    }
    if (patch.timezone !== undefined) {
      insertValues.timezone = patch.timezone;
      set.timezone = patch.timezone;
    }
    if (patch.weather_location !== undefined) {
      insertValues.weather_location = patch.weather_location;
      set.weather_location = patch.weather_location;
    }

    await db.transaction(async (tx) => {
      await tx
        .insert(user_settings)
        .values(insertValues)
        .onConflictDoUpdate({ target: user_settings.user_id, set });
      await tx.insert(command_log).values({
        id: cmd.id,
        user_id: userId,
        name: cmd.name,
        payload: cmd.payload,
        device_id: deviceId,
        hlc: cmd.hlc,
        result: 'applied',
        reject_reason: null,
      });
    });
    return { id: cmd.id, result: 'applied' };
  }

  async function handleCommand(
    userId: string,
    deviceId: string,
    cmd: CommandEnvelope,
  ): Promise<CommandOutcome> {
    // Idempotency by command id (§8 step 5).
    const [existing] = await db
      .select({ user_id: command_log.user_id, result: command_log.result })
      .from(command_log)
      .where(eq(command_log.id, cmd.id))
      .limit(1);
    if (existing) {
      if (existing.user_id !== userId) {
        // Foreign command id: reject without logging (the id is taken).
        return {
          id: cmd.id,
          result: 'rejected',
          reject_code: 'E_OWNERSHIP',
          reject_reason: 'command id belongs to another user',
        };
      }
      return {
        id: cmd.id,
        result: 'noop',
        original_result: existing.result === 'applied' ? 'applied' : 'rejected',
      };
    }

    if (cmd.name === SETTINGS_UPDATE) return applySettingsUpdate(userId, deviceId, cmd);
    return logRejection(
      userId,
      deviceId,
      cmd,
      'E_UNKNOWN_COMMAND',
      `unknown command "${cmd.name}" (s10 wires settings.update; full catalog arrives in s11)`,
    );
  }

  return {
    async handleUpload(userId, body): Promise<UploadResponse> {
      const parsed = uploadRequestSchema.safeParse(body);
      if (!parsed.success) return { kind: 'parse_error', issues: parsed.error.issues };
      const { device_id, commands } = parsed.data;

      // Rate limit per user+verb (§13), pre-checked over the whole batch so a
      // 429 applies atomically (nothing in the upload was executed).
      const perVerb = new Map<string, number>();
      for (const cmd of commands) perVerb.set(cmd.name, (perVerb.get(cmd.name) ?? 0) + 1);
      for (const [verb, count] of perVerb) {
        const res = limiter.consume(`${userId}:${verb}`, count);
        if (!res.allowed) {
          return { kind: 'rate_limited', verb, retryAfterSeconds: res.retryAfterSeconds };
        }
      }

      const results: CommandOutcome[] = [];
      for (const cmd of commands) {
        results.push(await handleCommand(userId, device_id, cmd));
      }
      return { kind: 'ok', results };
    },
  };
}
