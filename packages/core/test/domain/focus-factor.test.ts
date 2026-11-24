/**
 * The focus factor's allowed values (migration 0020): anywhere from 0 ("doesn't
 * count") to 1.0. Shared by the entity, the `timer.review` payload and the DB CHECK.
 * (The clock-out review's slider only OFFERS 0.3 and up — that is the web app's
 * choice, not a rule here.)
 */
import { describe, expect, it } from 'vitest';

import { COMMAND_SCHEMAS, isFocusFactor, timeEntrySchema } from '../../src/index';

describe('focus factor: 0 … 1.0', () => {
  it('accepts every value from 0 to 1, rejects below 0, above 1 and non-numbers', () => {
    for (const v of [0, 0.1, 0.2, 0.3, 0.45, 0.5, 1]) expect(isFocusFactor(v)).toBe(true);
    for (const v of [-0.1, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) expect(isFocusFactor(v)).toBe(false);
  });

  it('the timer.review payload follows it', () => {
    const review = COMMAND_SCHEMAS['timer.review'];
    const entry_id = '00000000-0000-4000-8000-000000000001';
    for (const focus_factor of [0, 0.1, 0.2, 0.3, 1]) {
      expect(review.safeParse({ entry_id, focus_factor, completed_session: false }).success).toBe(true);
    }
    for (const focus_factor of [-0.1, 1.1]) {
      expect(review.safeParse({ entry_id, focus_factor, completed_session: false }).success).toBe(false);
    }
  });

  it('the time entry allows it too, and null (not reviewed yet)', () => {
    const f = timeEntrySchema.shape.focus_factor;
    expect(f.safeParse(0).success).toBe(true);
    expect(f.safeParse(0.2).success).toBe(true);
    expect(f.safeParse(null).success).toBe(true);
    expect(f.safeParse(-0.1).success).toBe(false);
    expect(f.safeParse(1.2).success).toBe(false);
  });
});