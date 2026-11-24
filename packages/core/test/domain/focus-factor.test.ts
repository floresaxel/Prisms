/**
 * The focus factor's allowed values (migration 0019): 0 ("doesn't count"), or
 * 0.3–1.0 — nothing between 0 and the floor. Shared by the entity, the
 * `timer.review` payload and the DB CHECK.
 */
import { describe, expect, it } from 'vitest';

import { COMMAND_SCHEMAS, FOCUS_FACTOR_MIN, isFocusFactor, timeEntrySchema } from '../../src/index';

describe('focus factor: 0, or 0.3–1.0', () => {
  it('accepts 0 and the range, rejects the gap, below 0 and above 1', () => {
    for (const v of [0, 0.3, 0.45, 0.5, 1]) expect(isFocusFactor(v)).toBe(true);
    for (const v of [0.1, 0.29, -0.1, 1.01, Number.NaN]) expect(isFocusFactor(v)).toBe(false);
    expect(FOCUS_FACTOR_MIN).toBe(0.3);
  });

  it('the timer.review payload follows it', () => {
    const review = COMMAND_SCHEMAS['timer.review'];
    const entry_id = '00000000-0000-4000-8000-000000000001';
    expect(review.safeParse({ entry_id, focus_factor: 0, completed_session: false }).success).toBe(true);
    expect(review.safeParse({ entry_id, focus_factor: 0.3, completed_session: false }).success).toBe(true);
    expect(review.safeParse({ entry_id, focus_factor: 0.2, completed_session: false }).success).toBe(false);
  });

  it('the time entry allows it too, and null (not reviewed yet)', () => {
    const f = timeEntrySchema.shape.focus_factor;
    expect(f.safeParse(0).success).toBe(true);
    expect(f.safeParse(null).success).toBe(true);
    expect(f.safeParse(0.2).success).toBe(false);
  });
});