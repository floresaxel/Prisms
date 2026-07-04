import { describe, expect, it } from 'vitest';

import {
  commandEnvelopeSchema,
  journalWriteSchema,
  settingsUpdateSchema,
  uploadRequestSchema,
} from '../../src/index';

/** §D6 canonical emoji/text corpus — must survive every layer byte-identical. */
const D6_CORPUS = ['👍🏽', '👨‍👩‍👧‍👦', '🇫🇷', '❤️', 'café', 'שלום 🌍 hello'];

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

describe('journal.write payload (§8.1, J1)', () => {
  const base = { id: '01900000-0000-7000-8000-000000000abc', entry_date: '2026-06-11' };

  it('round-trips the D6 emoji/markdown corpus unchanged (incl. JSON over sync)', () => {
    for (const content of D6_CORPUS) {
      const payload = { ...base, content: `# Day\n\n${content}` };
      const parsed = journalWriteSchema.parse(payload);
      expect(parsed).toEqual(payload);
      // rows travel as JSON — surrogate pairs must survive the round-trip too.
      expect(journalWriteSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(payload);
    }
  });

  it('is strict — month_key is server-derived and never in the payload', () => {
    expect(journalWriteSchema.safeParse({ ...base, content: 'x', month_key: '2026-06' }).success).toBe(false);
    expect(journalWriteSchema.safeParse({ ...base, content: 'x', user_id: base.id }).success).toBe(false);
  });

  it('rejects a bad date or a missing content', () => {
    expect(journalWriteSchema.safeParse({ ...base, entry_date: '2026-13-01', content: 'x' }).success).toBe(false);
    expect(journalWriteSchema.safeParse({ id: base.id, entry_date: base.entry_date }).success).toBe(false);
  });
});
