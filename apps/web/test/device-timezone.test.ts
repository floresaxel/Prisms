// @vitest-environment jsdom
/**
 * The account's timezone follows the device's (device-timezone.ts): the pure
 * decision. Only a CHANGE this device sees moves the account; the first zone a
 * device reports is just remembered, so signing in somewhere never rewrites it.
 */
import { describe, expect, it } from 'vitest';

import { decideDeviceTimezone } from '../src/device-timezone';

describe('decideDeviceTimezone', () => {
  it('remembers the first zone a device reports, and moves nothing', () => {
    expect(decideDeviceTimezone('Asia/Tokyo', null, 'America/New_York')).toEqual({ kind: 'baseline', device: 'Asia/Tokyo' });
  });

  it('does nothing while the device stays where it was — even if the account was set elsewhere by hand', () => {
    expect(decideDeviceTimezone('America/New_York', 'America/New_York', 'Europe/London')).toEqual({ kind: 'none' });
  });

  it('follows the device when it moves', () => {
    expect(decideDeviceTimezone('Asia/Tokyo', 'America/New_York', 'America/New_York')).toEqual({ kind: 'follow', device: 'Asia/Tokyo', from: 'America/New_York' });
  });

  it('a move to where the account already is only updates what this device last saw', () => {
    expect(decideDeviceTimezone('Asia/Tokyo', 'America/New_York', 'Asia/Tokyo')).toEqual({ kind: 'moved', device: 'Asia/Tokyo' });
  });

  it('ignores a device that reports nothing usable', () => {
    expect(decideDeviceTimezone(null, 'America/New_York', 'America/New_York')).toEqual({ kind: 'none' });
    expect(decideDeviceTimezone('Not/AZone', 'America/New_York', 'America/New_York')).toEqual({ kind: 'none' });
  });
});