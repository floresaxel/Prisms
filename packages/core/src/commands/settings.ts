/**
 * settings.update — the first wired command (§8.1, s10).
 *
 * Minimal-field patch (§2 principle 8): only the fields the user changed are
 * present; absent fields are never written. weather_location may be set to
 * null explicitly (clearing it) — that is different from omitting it.
 */
import { z } from 'zod';

// single source of truth: the same shape user_settings.weather_location uses
import { weatherLocationSchema } from '../domain/entities';

export const settingsUpdateSchema = z
  .strictObject({
    day_reset_hour: z.number().int().min(0).max(23).optional(),
    // SEC-3/F6: an IANA zone name is short ('America/Argentina/Buenos_Aires' is 30).
    timezone: z.string().min(1).max(100).optional(),
    weather_location: weatherLocationSchema.nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'settings.update requires at least one field',
  });
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export const SETTINGS_UPDATE = 'settings.update' as const;
