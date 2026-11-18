import { describe, expect, it } from 'vitest';

import { allTimezones, clockInZone, describeTimezone, isValidTimezone, timezoneTitle } from '../src/timezones';

describe('timezones', () => {
  it('validates IANA names and rejects junk', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });

  it('lists zones with UTC first and no duplicates', () => {
    const zones = allTimezones();
    expect(zones[0]).toBe('UTC');
    expect(zones).toContain('America/New_York');
    expect(new Set(zones).size).toBe(zones.length);
  });

  it('reads the wall clock of the chosen zone, not the machine', () => {
    const at = new Date('2026-01-15T12:00:00Z');
    expect(clockInZone('UTC', at)).toBe('12:00');
    expect(clockInZone('America/New_York', at)).toBe('07:00');
    expect(clockInZone('Asia/Tokyo', at)).toBe('21:00');
  });

  it('describes where a zone is', () => {
    const at = new Date('2026-01-15T12:00:00Z');
    expect(describeTimezone('America/New_York', at).place).toBe('New York, America');
    expect(describeTimezone('America/Argentina/Buenos_Aires', at).place).toBe('Buenos Aires, Argentina, America');
    expect(describeTimezone('UTC', at).place).toBe('UTC');
    const title = timezoneTitle('America/New_York', at);
    expect(title).toContain('New York, America');
    expect(title).toContain('(America/New_York)');
  });
});
