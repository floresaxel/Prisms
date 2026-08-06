/**
 * SEC-3: every attacker-supplied field has a ceiling.
 *
 * Before this, the only bound on most command input was the 2 MB request body,
 * so one upload could carry a 2 MB title, a 55k-element `depends_on` (one serial
 * DB query each) or arbitrarily deep JSON. These tests pin the ceilings and,
 * importantly, that legitimate input still passes.
 */
import { describe, expect, it } from 'vitest';

import { COMMAND_SCHEMAS, MAX_RENORMALIZE_NODES } from '../../src/commands/payloads';
import { MAX_DEPENDS_ON, commandEnvelopeSchema } from '../../src/commands/envelope';
// MAX_TITLE_LENGTH moved to domain/entities (the entity schemas need it too).
import { MAX_TITLE_LENGTH } from '../../src/domain/entities';
import {
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  MAX_JSON_STRING_LENGTH,
  boundedJsonSchema,
  jsonLimitViolation,
} from '../../src/domain/primitives';

const uuid = (n = 1) => `0199e2a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const hlc = '000000000001-0001-device';

describe('SEC-3/F6 — free-text fields are bounded', () => {
  it('accepts a normal title and rejects a 2 MB one', () => {
    const ok = COMMAND_SCHEMAS['node.rename'].safeParse({ id: uuid(), title: 'Write the report' });
    expect(ok.success).toBe(true);

    const huge = COMMAND_SCHEMAS['node.rename'].safeParse({ id: uuid(), title: 'x'.repeat(2 * 1024 * 1024) });
    expect(huge.success).toBe(false);
  });

  it('bounds the title exactly at the documented ceiling', () => {
    const at = COMMAND_SCHEMAS['node.rename'].safeParse({ id: uuid(), title: 'x'.repeat(MAX_TITLE_LENGTH) });
    expect(at.success).toBe(true);
    const over = COMMAND_SCHEMAS['node.rename'].safeParse({ id: uuid(), title: 'x'.repeat(MAX_TITLE_LENGTH + 1) });
    expect(over.success).toBe(false);
  });

  it('bounds description, label, sort_order and rrule', () => {
    expect(COMMAND_SCHEMAS['node.set_description'].safeParse({ id: uuid(), description: 'x'.repeat(20_001) }).success).toBe(false);
    expect(COMMAND_SCHEMAS['tag.rename'].safeParse({ id: uuid(), label: 'x'.repeat(201) }).success).toBe(false);
    expect(COMMAND_SCHEMAS['node.reorder'].safeParse({ id: uuid(), sort_order: 'a'.repeat(201) }).success).toBe(false);
    expect(
      COMMAND_SCHEMAS['habit.create'].safeParse({
        id: uuid(), vision_id: uuid(2), title: 'Run', rrule: 'F'.repeat(501), streak_mode: 'daily',
      }).success,
    ).toBe(false);
  });

  it('still accepts a realistic habit', () => {
    expect(
      COMMAND_SCHEMAS['habit.create'].safeParse({
        id: uuid(), vision_id: uuid(2), title: 'Morning Run', rrule: 'FREQ=DAILY', streak_mode: 'daily',
      }).success,
    ).toBe(true);
  });
});

describe('SEC-3/F5 — array fields are bounded', () => {
  it('accepts a handful of causal dependencies', () => {
    const parsed = commandEnvelopeSchema.safeParse({
      id: uuid(), name: 'node.rename', hlc, payload: {}, depends_on: [uuid(2), uuid(3)],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a depends_on list past the cap (one serial query each)', () => {
    const many = Array.from({ length: MAX_DEPENDS_ON + 1 }, (_, i) => uuid(i + 1));
    const parsed = commandEnvelopeSchema.safeParse({ id: uuid(), name: 'node.rename', hlc, payload: {}, depends_on: many });
    expect(parsed.success).toBe(false);
  });

  it('rejects an oversized renormalize batch', () => {
    const ids = Array.from({ length: MAX_RENORMALIZE_NODES + 1 }, (_, i) => uuid(i + 1));
    expect(COMMAND_SCHEMAS['layout.renormalize_order'].safeParse({ parent_id: null, node_ids: ids }).success).toBe(false);
    expect(COMMAND_SCHEMAS['layout.renormalize_order'].safeParse({ parent_id: null, node_ids: [uuid()] }).success).toBe(true);
  });
});

describe('SEC-3/F6 — JSON ceilings', () => {
  /** Build `depth`-deep nesting without recursing (the input is the point). */
  const nest = (depth: number): unknown => {
    let value: unknown = 1;
    for (let i = 0; i < depth; i += 1) value = { a: value };
    return value;
  };

  it('passes ordinary rule payloads', () => {
    expect(boundedJsonSchema.safeParse({ all: [{ fact: 'task.status', op: 'eq', value: 'todo' }] }).success).toBe(true);
  });

  it('rejects over-deep nesting', () => {
    expect(jsonLimitViolation(nest(MAX_JSON_DEPTH - 1))).toBeNull();
    expect(jsonLimitViolation(nest(MAX_JSON_DEPTH + 5))).toMatch(/nested deeper/);
    expect(boundedJsonSchema.safeParse(nest(MAX_JSON_DEPTH + 5)).success).toBe(false);
  });

  it('rejects too many values', () => {
    expect(jsonLimitViolation(Array.from({ length: MAX_JSON_NODES + 10 }, (_, i) => i))).toMatch(/more than/);
  });

  it('rejects an over-long embedded string', () => {
    expect(jsonLimitViolation({ note: 'x'.repeat(MAX_JSON_STRING_LENGTH + 1) })).toMatch(/string longer than/);
  });

  it('rejects an over-long key', () => {
    expect(jsonLimitViolation({ ['k'.repeat(201)]: 1 })).toMatch(/key longer than/);
  });

  it('does NOT overflow the stack on pathological nesting', () => {
    // The guard is iterative precisely so this returns a rejection instead of
    // throwing RangeError out of safeParse (which only traps ZodError).
    expect(() => jsonLimitViolation(nest(200_000))).not.toThrow();
    expect(jsonLimitViolation(nest(200_000))).toMatch(/nested deeper/);
  });

  it('bounds a blocker predicate through the real command schema', () => {
    expect(
      COMMAND_SCHEMAS['blocker.create'].safeParse({
        id: uuid(), scope: { kind: 'all' }, predicate: nest(MAX_JSON_DEPTH + 5), label: 'deep',
      }).success,
    ).toBe(false);
  });
});
