/**
 * SEC-4/F2 — the `matches` op must not be able to hang the server.
 *
 * JavaScript's regex engine backtracks and has no timeout, so a 6-character
 * pattern like `(a+)+$` runs effectively forever on a moderately long subject.
 * This is reachable server-side: a blocker rule's predicate is evaluated inside
 * `timer.clock_in` via isBlockedForAcceptance, on the single shared event loop —
 * so one user's rule is an outage for every user on the node.
 *
 * The pre-existing S3-F7 control capped pattern LENGTH (200), which has nothing
 * to do with backtracking. The control now is a linear-time-safe pattern subset.
 */
import { describe, expect, it } from 'vitest';

import { buildFactContext } from '../../src/status/context';
import {
  MAX_MATCHES_SUBJECT_LENGTH,
  evalPredicate,
  hasUnsafeMatchesPattern,
  unsafeMatchesPatternReason,
} from '../../src/status/predicate';
import { isoToEpochMillis } from '../../src/time/instant';
import { idOf, makeNode } from '../helpers/fixtures';

const NOW = isoToEpochMillis('2026-06-12T16:00:00.000Z');

/** A minimal owned task whose title is the regex subject. */
function worldWithTitle(title: string) {
  const vision = makeNode({ id: idOf(1), node_type: 'vision' });
  const task = makeNode({ id: idOf(2), node_type: 'task', parent_id: vision.id, title });
  return { ctx: buildFactContext({ nodes: [vision, task] }), task };
}

describe('SEC-4/F2 — catastrophic-backtracking patterns are refused', () => {
  it.each([
    ['(a+)+$', /nests a quantifier/],
    ['(a*)*b', /nests a quantifier/],
    ['(\\w+\\s?)*$', /nests a quantifier/],
    ['(a|a)*$', /alternation inside a repeated group/],
    ['(x|y|xy)+z', /alternation inside a repeated group/],
    ['(.*a){20}', /nests a quantifier/],
  ])('rejects %s', (pattern, reason) => {
    expect(unsafeMatchesPatternReason(pattern)).toMatch(reason);
  });

  it('rejects backreferences and lookaround', () => {
    expect(unsafeMatchesPatternReason('(a)\\1+')).toMatch(/backreference/);
    expect(unsafeMatchesPatternReason('(?=(a+)+)')).toMatch(/lookaround/);
    expect(unsafeMatchesPatternReason('(?<=foo)bar')).toMatch(/lookaround/);
  });

  it('still rejects an overlong pattern (S3-F7 stays enforced)', () => {
    expect(unsafeMatchesPatternReason('a'.repeat(201))).toMatch(/exceeds 200 characters/);
  });

  it('rejects a pattern that is not valid regex', () => {
    expect(unsafeMatchesPatternReason('([')).not.toBeNull();
  });
});

describe('SEC-4/F2 — ordinary patterns still work', () => {
  it.each([
    '^Deploy',
    'urgent|important',
    '\\bfoo\\b',
    '[A-Z]+',
    'report-\\d{4}',
    'task \\d+ done',
    '^(chore|fix|feat): .+',
    'a?b*c+',
    '(?:prefix-)?name',
    '[a-z0-9_-]{3,32}',
  ])('accepts %s', (pattern) => {
    expect(unsafeMatchesPatternReason(pattern)).toBeNull();
  });
});

describe('SEC-4/F2 — the evaluator fails safe and stays fast', () => {
  const predicateWith = (pattern: string) => ({ fact: 'node.title', op: 'matches' as const, value: pattern });

  it('flags an unsafe pattern through the predicate walker', () => {
    expect(hasUnsafeMatchesPattern(predicateWith('(a+)+$'))).toBe(true);
    expect(hasUnsafeMatchesPattern(predicateWith('^Deploy'))).toBe(false);
  });

  it('REGRESSION: the classic ReDoS payload returns promptly instead of hanging', () => {
    // Pre-fix, this exact pairing backtracked ~2^46 times — minutes to forever,
    // on the shared event loop. The evaluator now refuses to run the pattern.
    const { ctx, task } = worldWithTitle(`${'a'.repeat(46)}!`);

    const startedAt = Date.now();
    const result = evalPredicate(predicateWith('(a+)+$'), task, ctx, NOW);
    const elapsed = Date.now() - startedAt;

    expect(result).toBe('unknown'); // fail safe — never a false 'true'/'false'
    expect(elapsed).toBeLessThan(1_000);
  });

  it('keeps evaluating safe patterns correctly', () => {
    const { ctx, task } = worldWithTitle('Lecture 4: dynamics');
    expect(evalPredicate(predicateWith('lecture'), task, ctx, NOW)).toBe('true');
    expect(evalPredicate(predicateWith('^lecture \\d+'), task, ctx, NOW)).toBe('true');
    expect(evalPredicate(predicateWith('seminar'), task, ctx, NOW)).toBe('false');
  });

  it('truncates an over-long subject rather than scanning all of it', () => {
    // The match target sits past the cap, so it must NOT be found.
    const { ctx, task } = worldWithTitle('x'.repeat(MAX_MATCHES_SUBJECT_LENGTH + 100) + 'NEEDLE');
    expect(evalPredicate(predicateWith('NEEDLE'), task, ctx, NOW)).toBe('false');
  });
});
