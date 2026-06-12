/**
 * S2 DoD: HLC property tests — monotonic, total order, device tiebreak.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { hlcStringSchema } from '../../src/domain/primitives';
import { isErr, unwrap } from '../../src/domain/result';
import { asEpochMillis } from '../../src/time/instant';
import {
  HLC_COUNTER_MAX,
  hlcCompare,
  hlcCompareEncoded,
  hlcEncode,
  hlcParse,
  hlcTick,
  type Hlc,
} from '../../src/time/hlc';

const deviceIdArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,16}$/);

const hlcArb: fc.Arbitrary<Hlc> = fc.record({
  physicalMs: fc.integer({ min: 0, max: 2 ** 48 - 1 }),
  counter: fc.integer({ min: 0, max: HLC_COUNTER_MAX }),
  deviceId: deviceIdArb,
});

describe('hlcTick monotonicity', () => {
  it('strictly increases for any wall-clock behavior (stalls, jumps back)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 2 ** 44 }), {
          minLength: 2,
          maxLength: 300,
        }),
        (nows) => {
          let prev: Hlc | null = null;
          for (const now of nows) {
            const next = hlcTick(prev, asEpochMillis(now), 'device-a');
            if (prev !== null) {
              expect(hlcCompare(next, prev)).toBe(1);
              expect(hlcEncode(next) > hlcEncode(prev)).toBe(true);
            }
            prev = next;
          }
        },
      ),
    );
  });

  it('survives a frozen clock via the counter', () => {
    let hlc = hlcTick(null, asEpochMillis(1000), 'dev');
    for (let i = 0; i < 5; i += 1) {
      const next = hlcTick(hlc, asEpochMillis(1000), 'dev');
      expect(hlcCompare(next, hlc)).toBe(1);
      hlc = next;
    }
    expect(hlc.physicalMs).toBe(1000);
    expect(hlc.counter).toBe(5);
  });

  it('overflows the 16-bit counter into +1ms physical', () => {
    const atMax: Hlc = { physicalMs: 5000, counter: HLC_COUNTER_MAX, deviceId: 'dev' };
    const next = hlcTick(atMax, asEpochMillis(4000), 'dev');
    expect(next).toEqual({ physicalMs: 5001, counter: 0, deviceId: 'dev' });
  });
});

describe('hlcCompare is a total order', () => {
  it('is reflexive, antisymmetric, and transitive', () => {
    fc.assert(
      fc.property(hlcArb, hlcArb, hlcArb, (a, b, c) => {
        expect(hlcCompare(a, a)).toBe(0);
        expect(hlcCompare(a, b)).toBe(-hlcCompare(b, a));
        if (hlcCompare(a, b) <= 0 && hlcCompare(b, c) <= 0) {
          expect(hlcCompare(a, c)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it('equals zero only for identical values', () => {
    fc.assert(
      fc.property(hlcArb, hlcArb, (a, b) => {
        if (hlcCompare(a, b) === 0) {
          expect(a).toEqual(b);
        }
      }),
    );
  });

  it('breaks physical+counter ties deterministically by device id', () => {
    const a: Hlc = { physicalMs: 99, counter: 3, deviceId: 'alpha' };
    const b: Hlc = { physicalMs: 99, counter: 3, deviceId: 'beta' };
    expect(hlcCompare(a, b)).toBe(-1);
    expect(hlcCompare(b, a)).toBe(1);
  });
});

describe('hlc encoding', () => {
  it('round-trips through encode/parse', () => {
    fc.assert(
      fc.property(hlcArb, (hlc) => {
        expect(unwrap(hlcParse(hlcEncode(hlc)))).toEqual(hlc);
      }),
    );
  });

  it('always satisfies the shared hlcStringSchema', () => {
    fc.assert(
      fc.property(hlcArb, (hlc) => {
        expect(hlcStringSchema.safeParse(hlcEncode(hlc)).success).toBe(true);
      }),
    );
  });

  it('string order on encodings equals structural HLC order (§7.3 LWW)', () => {
    fc.assert(
      fc.property(hlcArb, hlcArb, (a, b) => {
        expect(hlcCompareEncoded(hlcEncode(a), hlcEncode(b))).toBe(
          hlcCompare(a, b),
        );
      }),
    );
  });

  it('parses device ids containing dashes', () => {
    const hlc: Hlc = { physicalMs: 1, counter: 2, deviceId: 'dev-a-1' };
    expect(unwrap(hlcParse(hlcEncode(hlc)))).toEqual(hlc);
  });

  it('rejects malformed strings with E_PARSE', () => {
    for (const bad of ['', 'zzz', '12-34-dev', '018f6d3e0000-001-dev', 'g'.repeat(12) + '-0000-dev']) {
      const parsed = hlcParse(bad);
      expect(isErr(parsed)).toBe(true);
      if (isErr(parsed)) expect(parsed.error.code).toBe('E_PARSE');
    }
  });

  it('rejects out-of-range and malformed inputs to encode/tick', () => {
    expect(() => hlcEncode({ physicalMs: -1, counter: 0, deviceId: 'd' })).toThrow(TypeError);
    expect(() => hlcEncode({ physicalMs: 2 ** 48, counter: 0, deviceId: 'd' })).toThrow(TypeError);
    expect(() => hlcEncode({ physicalMs: 0, counter: 0x10000, deviceId: 'd' })).toThrow(TypeError);
    expect(() => hlcEncode({ physicalMs: 0, counter: 0, deviceId: 'bad space' })).toThrow(TypeError);
    expect(() => hlcTick(null, asEpochMillis(0), '')).toThrow(TypeError);
  });
});
