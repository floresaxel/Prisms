import { describe, expect, it } from 'vitest';

import {
  commandEnvelopeSchema,
  settingsUpdateSchema,
  uploadRequestSchema,
} from '../../src/index';

const envelope = {
  id: '01900000-0000-7000-8000-000000000abc',
  name: 'settings.update',
  hlc: '0190000000ff-0001-device-a',
  payload: { day_reset_hour: 5 },
};

describe('command envelope (§8)', () => {
  it('round-trips a valid envelope', () => {
    expect(commandEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it('rejects a malformed hlc', () => {
    expect(
      commandEnvelopeSchema.safeParse({ ...envelope, hlc: 'not-an-hlc' }).success,
    ).toBe(false);
  });

  it('rejects an upload with no commands or a bad device id', () => {
    expect(
      uploadRequestSchema.safeParse({ device_id: 'dev-1', commands: [] }).success,
    ).toBe(false);
    expect(
      uploadRequestSchema.safeParse({ device_id: 'bad device', commands: [envelope] })
        .success,
    ).toBe(false);
    expect(
      uploadRequestSchema.parse({ device_id: 'dev-1', commands: [envelope] }).commands,
    ).toHaveLength(1);
  });
});

describe('settings.update payload (§8.1)', () => {
  it('accepts minimal-field patches', () => {
    expect(settingsUpdateSchema.parse({ day_reset_hour: 6 })).toEqual({
      day_reset_hour: 6,
    });
    expect(
      settingsUpdateSchema.parse({ weather_location: null }).weather_location,
    ).toBeNull();
    expect(
      settingsUpdateSchema.parse({
        timezone: 'Europe/Paris',
        weather_location: { lat: 48.85, lon: 2.35, label: 'Paris' },
      }).timezone,
    ).toBe('Europe/Paris');
  });

  it('rejects an empty patch (no fields = nothing to write)', () => {
    expect(settingsUpdateSchema.safeParse({}).success).toBe(false);
  });

  it('rejects out-of-range and unknown fields', () => {
    expect(settingsUpdateSchema.safeParse({ day_reset_hour: 24 }).success).toBe(false);
    expect(settingsUpdateSchema.safeParse({ timezone: '' }).success).toBe(false);
    expect(
      settingsUpdateSchema.safeParse({ weather_location: { lat: 91, lon: 0, label: 'x' } })
        .success,
    ).toBe(false);
    expect(settingsUpdateSchema.safeParse({ user_id: 'sneaky' }).success).toBe(false);
  });
});
