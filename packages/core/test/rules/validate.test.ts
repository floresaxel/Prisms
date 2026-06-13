/**
 * S7 DoD: self-trigger rejection at rule creation (§9.1), plus payload
 * schema validation.
 */
import { describe, expect, it } from 'vitest';

import { validateAutomationRule, type RuleCandidate } from '../../src/rules/validate';
import { idOf, makeAutomationRule } from '../helpers/fixtures';

describe('validateAutomationRule (§9.1)', () => {
  it('accepts a well-formed rule whose output cannot match its own trigger', () => {
    const rule: RuleCandidate = {
      trigger: 'task_completed',
      conditions: { all: [{ fact: 'node.title', op: 'matches', value: 'lecture' }] },
      actions: [{ action: 'spawn_task', slot: 0, template: { title: 'Pre-brief: study' } }],
    };
    expect(validateAutomationRule(rule).ok).toBe(true);
  });

  it('rejects a directly self-triggering rule (E_RULE_SELF_TRIGGER)', () => {
    // fires on task_created for any task titled "todo …" and spawns "todo: x"
    const rule: RuleCandidate = {
      trigger: 'task_created',
      conditions: { all: [{ fact: 'node.title', op: 'matches', value: '^todo' }] },
      actions: [{ action: 'spawn_task', slot: 0, template: { title: 'todo follow-up' } }],
    };
    const result = validateAutomationRule(rule);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_RULE_SELF_TRIGGER');
  });

  it('rejects a rule whose spawned title carries a placeholder (could become anything)', () => {
    const rule: RuleCandidate = {
      trigger: 'task_created',
      conditions: { all: [{ fact: 'node.title', op: 'matches', value: 'review' }] },
      actions: [
        { action: 'spawn_task', slot: 0, template: { title: 'Review: {trigger.title}' } },
      ],
    };
    const result = validateAutomationRule(rule);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_RULE_SELF_TRIGGER');
  });

  it('rejects a transitive cycle through an existing rule', () => {
    // existing: task_created titled "alpha …" ⇒ spawns "beta"
    const existing = makeAutomationRule({
      id: idOf(700),
      trigger: 'task_created',
      conditions: { all: [{ fact: 'node.title', op: 'matches', value: '^alpha' }] },
      actions: [{ action: 'spawn_task', slot: 0, template: { title: 'beta task' } }],
    });
    // candidate: task_created titled "beta …" ⇒ spawns "alpha" ⇒ cycle
    const candidate: RuleCandidate = {
      trigger: 'task_created',
      conditions: { all: [{ fact: 'node.title', op: 'matches', value: '^beta' }] },
      actions: [{ action: 'spawn_task', slot: 0, template: { title: 'alpha task' } }],
    };
    const result = validateAutomationRule(candidate, [existing]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_RULE_SELF_TRIGGER');
  });

  it('allows a chain that cannot loop back (task_completed link is unreachable)', () => {
    // existing fires on task_completed — engine output is task_created, so it
    // can never re-trigger; no cycle.
    const existing = makeAutomationRule({
      id: idOf(701),
      trigger: 'task_completed',
      conditions: { all: [{ fact: 'node.title', op: 'matches', value: '^beta' }] },
      actions: [{ action: 'spawn_task', slot: 0, template: { title: 'alpha task' } }],
    });
    const candidate: RuleCandidate = {
      trigger: 'task_created',
      conditions: { all: [{ fact: 'node.title', op: 'matches', value: '^alpha' }] },
      actions: [{ action: 'spawn_task', slot: 0, template: { title: 'beta task' } }],
    };
    expect(validateAutomationRule(candidate, [existing]).ok).toBe(true);
  });

  it('rejects malformed actions and conditions with E_PARSE', () => {
    expect(
      validateAutomationRule({ trigger: 'task_created', conditions: { all: [] }, actions: [] }).ok,
    ).toBe(false);
    const badConds = validateAutomationRule({
      trigger: 'task_created',
      conditions: { bogus: true },
      actions: [{ action: 'spawn_task', slot: 0, template: { title: 'x' } }],
    });
    expect(badConds.ok).toBe(false);
    if (!badConds.ok) expect(badConds.error.code).toBe('E_PARSE');
  });
});
