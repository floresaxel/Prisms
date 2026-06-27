/**
 * M1 — `mergeHlc` receive rule (1.3 §7.9a). The local clock, on observing a
 * remote event, must advance so a subsequent local event is causally after BOTH
 * the prior local state and the remote one, keeping this device's id.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { asEpochMillis } from '../../src/time/instant';
import { HLC_COUNTER_MAX, hlcCompare, mergeHlc, type Hlc } from '../../src/time/hlc';

const deviceIdArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,16}$/);
const hlcArb: fc.Arbitrary<Hlc> = fc.record({
  physicalMs: fc.integer({ min: 0, max: 2 ** 44 }),
  counter: fc.integer({ min: 0, max: HLC_COUNTER_MAX }),
  deviceId: deviceIdArb,
});

describe('mergeHlc (receive rule)', () => {
  it('strictly dominates both the local and the remote clock', () => {
    fc.assert(
      fc.property(fc.option(hlcArb, { nil: null }), hlcArb, fc.integer({ min: 0, max: 2 ** 44 }), (local, remote, now) => {
        const merged = mergeHlc(local, remote, asEpochMillis(now), 'dev-local');
        expect(hlcCompare(merged, remote)).toBe(1);
        if (local !== null) expect(hlcCompare(merged, local)).toBe(1);
      }),
    );
  });

  it('keeps THIS device id, not the remote one', () => {
    fc.assert(
      fc.property(fc.option(hlcArb, { nil: null }), hlcArb, fc.integer({ min: 0, max: 2 ** 44 }), (local, remote, now) => {
        expect(mergeHlc(local, remote, asEpochMillis(now), 'dev-local').deviceId).toBe('dev-local');
      }),
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(fc.option(hlcArb, { nil: null }), hlcArb, fc.integer({ min: 0, max: 2 ** 44 }), (local, remote, now) => {
        const a = mergeHlc(local, remote, asEpochMillis(now), 'd');
        const b = mergeHlc(local, remote, asEpochMillis(now), 'd');
        expect(a).toEqual(b);
      }),
    );
  });

  it('takes the wall clock when it leads both clocks (counter resets)', () => {
    const local: Hlc = { physicalMs: 1000, counter: 5, deviceId: 'd' };
    const remote: Hlc = { physicalMs: 2000, counter: 9, deviceId: 'e' };
    expect(mergeHlc(local, remote, asEpochMillis(3000), 'd')).toEqual({ physicalMs: 3000, counter: 0, deviceId: 'd' });
  });

  it('advances the counter past both when physical times tie', () => {
    const local: Hlc = { physicalMs: 2000, counter: 5, deviceId: 'd' };
    const remote: Hlc = { physicalMs: 2000, counter: 9, deviceId: 'e' };
    expect(mergeHlc(local, remote, asEpochMillis(1000), 'd')).toEqual({ physicalMs: 2000, counter: 10, deviceId: 'd' });
  });

  it('follows the remote counter when the remote physical time leads', () => {
    const local: Hlc = { physicalMs: 1000, counter: 5, deviceId: 'd' };
    const remote: Hlc = { physicalMs: 2000, counter: 9, deviceId: 'e' };
    expect(mergeHlc(local, remote, asEpochMillis(1500), 'd')).toEqual({ physicalMs: 2000, counter: 10, deviceId: 'd' });
  });

  it('overflows a maxed counter into +1ms', () => {
    const local: Hlc = { physicalMs: 2000, counter: HLC_COUNTER_MAX, deviceId: 'd' };
    const remote: Hlc = { physicalMs: 2000, counter: HLC_COUNTER_MAX, deviceId: 'e' };
    expect(mergeHlc(local, remote, asEpochMillis(0), 'd')).toEqual({ physicalMs: 2001, counter: 0, deviceId: 'd' });
  });
});
