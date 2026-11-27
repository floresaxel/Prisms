// @vitest-environment jsdom
/**
 * "Use this device's timezone" (device-timezone.ts): the pure decision. While it
 * is on, a zone this device has not pushed before (first seen, or the device
 * moved) moves the account; the same zone is never pushed twice, so two devices
 * in different zones don't fight. While it is off, the device is only noted.
 */
import { describe, expect, it } from 'vitest';

import { decideDeviceTimezone } from '../src/device-timezone';

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';

describe('decideDeviceTimezone — following the device (the default)', () => {
  it('a device seen for the first time moves the account to its zone', () => {
    expect(decideDeviceTimezone(TOKYO, null, NY, true)).toEqual({ kind: 'follow', device: TOKYO, from: NY });
  });

  it('a device already in the account’s zone is only noted', () => {
    expect(decideDeviceTimezone(NY, null, NY, true)).toEqual({ kind: 'remember', device: NY });
  });

  it('follows the device when it moves', () => {
    expect(decideDeviceTimezone(LA, NY, NY, true)).toEqual({ kind: 'follow', device: LA, from: NY });
  });

  it('does not push the same zone again — another device that moved the account since wins', () => {
    expect(decideDeviceTimezone(NY, NY, TOKYO, true)).toEqual({ kind: 'none' });
  });
});

describe('decideDeviceTimezone — a zone kept by hand (following off)', () => {
  it('a moved device is noted, and the account keeps its zone', () => {
    expect(decideDeviceTimezone(LA, NY, TOKYO, false)).toEqual({ kind: 'remember', device: LA });
    expect(decideDeviceTimezone(TOKYO, null, NY, false)).toEqual({ kind: 'remember', device: TOKYO });
  });

  it('nothing to do while the device stays put', () => {
    expect(decideDeviceTimezone(LA, LA, TOKYO, false)).toEqual({ kind: 'none' });
  });
});

describe('decideDeviceTimezone — nothing usable', () => {
  it('ignores a device that reports no zone, or one the runtime does not know', () => {
    expect(decideDeviceTimezone(null, NY, NY, true)).toEqual({ kind: 'none' });
    expect(decideDeviceTimezone('Not/AZone', NY, NY, true)).toEqual({ kind: 'none' });
  });
});
