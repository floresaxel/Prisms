/**
 * S2 DoD: uuidv5 determinism test (+ uuidv7 determinism with injected
 * Clock/Rng, §2 principle 7).
 */
import { v5 as uuidV5Lib } from 'uuid';
import { describe, expect, it } from 'vitest';

import { uuidSchema } from '../../src/domain/primitives';
import { PRISMS_NS, uuidV5, uuidV7, uuidV7From } from '../../src/domain/ids';
import { createManualClock } from '../../src/time/clock';
import { createSeededRng } from '../../src/time/rng';

const RFC_DNS_NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('PRISMS_NS', () => {
  it('is exactly uuidv5("prisms", DNS) — never change it', () => {
    expect(PRISMS_NS).toBe(uuidV5Lib('prisms', RFC_DNS_NS));
    expect(PRISMS_NS).toBe('0b8114a9-e130-548e-ba1e-2f28358da501');
  });
});

describe('uuidV5 determinism', () => {
  it('matches the RFC reference vector', () => {
    expect(uuidV5('python.org', RFC_DNS_NS)).toBe(
      '886313e1-3b8a-5372-9b90-0c9aee199e5d',
    );
  });

  it('same name ⇒ same id, on any "device"', () => {
    const name = 'rule-123:trigger-node-456:0'; // §9.4 shape
    expect(uuidV5(name)).toBe(uuidV5(name));
    expect(uuidSchema.safeParse(uuidV5(name)).success).toBe(true);
  });

  it('different slots ⇒ different ids', () => {
    expect(uuidV5('rule:trigger:0')).not.toBe(uuidV5('rule:trigger:1'));
  });
});

describe('uuidV7 with injected Clock/Rng', () => {
  it('two devices with identical clock+seed produce identical ids', () => {
    const a = uuidV7(createManualClock(1_718_000_000_000), createSeededRng(42));
    const b = uuidV7(createManualClock(1_718_000_000_000), createSeededRng(42));
    expect(a).toBe(b);
  });

  it('has v7 version and RFC variant bits', () => {
    const id = uuidV7(createManualClock(1_718_000_000_000), createSeededRng(1));
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
    expect(uuidSchema.safeParse(id).success).toBe(true);
  });

  it('is time-ordered: later ms ⇒ lexicographically larger id', () => {
    const rng = () => createSeededRng(7).randomBytes(16);
    expect(uuidV7From(1_000, rng()) < uuidV7From(2_000, rng())).toBe(true);
  });

  it('rejects short random buffers and bad timestamps', () => {
    expect(() => uuidV7From(1, new Uint8Array(8))).toThrow(TypeError);
    expect(() => uuidV7From(-1, new Uint8Array(16))).toThrow(TypeError);
    expect(() => uuidV7From(1.5, new Uint8Array(16))).toThrow(TypeError);
  });
});
