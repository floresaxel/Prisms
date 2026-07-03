/**
 * Rule-creation validation (§9.1): payload schemas, plus the guarantee that
 * "no rule's action pattern can trigger itself transitively"
 * (E_RULE_SELF_TRIGGER).
 *
 * Cycle analysis is conservative. Rule R links to rule S when S fires on
 * task_created and S's conditions COULD hold on a task R spawns. "Could
 * hold" reuses the tri-state evaluator against a synthetic spawned node in
 * an empty fact context: facts the template pins (title without
 * placeholders, description, estimate) resolve; everything else evaluates
 * `unknown`, and only a provable 'false' breaks the link. Titles containing
 * `{trigger.*}` placeholders could become anything ⇒ always link. A
 * task_completed rule can never be re-triggered by engine output (spawned
 * tasks are created, not completed), so cycles only ever form among
 * task_created rules.
 */
import type { AutomationRule, Node } from '../domain/entities';
import { SYNC_ROW_DEFAULTS } from '../domain/entities';
import { domainError } from '../domain/errors';
import { err, ok, type Result } from '../domain/result';
import { buildFactContext } from '../status/context';
import {
  evalPredicate,
  hasOverlongMatchesPattern,
  MAX_MATCHES_PATTERN_LENGTH,
  predicateSchema,
  referencesExternalFacts,
} from '../status/predicate';
import { isoToEpochMillis } from '../time/instant';

import {
  automationActionsSchema,
  interpolate,
  type AutomationAction,
} from './actions';

export interface RuleCandidate {
  trigger: 'task_completed' | 'task_created';
  conditions: unknown;
  actions: unknown;
}

const HAS_PLACEHOLDER = /\{trigger\.\w+\}/;

const SYNTHETIC_BASE: Node = {
  id: '00000000-0000-7000-8000-00000000fffe',
  user_id: '00000000-0000-7000-8000-00000000ffff',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  deleted_at: null,
  ...SYNC_ROW_DEFAULTS,
  parent_id: null,
  node_type: 'task',
  title: '',
  description: '',
  sort_order: 'a0',
  start_date: null,
  due_date: null,
  estimate_minutes: null,
  completed_at: null,
  completion_disposition: null,
  completed_in_block_id: null,
  habit_id: null,
  attributes: {},
};

interface RuleNode {
  id: string;
  trigger: 'task_completed' | 'task_created';
  conditions: unknown;
  actions: readonly AutomationAction[];
}

/** Could `conditions` hold on a task spawned from `template`? Conservative. */
function couldMatchSpawn(
  conditions: unknown,
  action: AutomationAction,
): boolean {
  const { template } = action;
  if (HAS_PLACEHOLDER.test(template.title)) return true;
  const synthetic: Node = {
    ...SYNTHETIC_BASE,
    title: interpolate(template.title, SYNTHETIC_BASE),
    description:
      template.description !== undefined && !HAS_PLACEHOLDER.test(template.description)
        ? template.description
        : '',
    estimate_minutes: template.estimate_minutes ?? null,
  };
  const ctx = buildFactContext({ nodes: [synthetic] });
  const verdict = evalPredicate(
    conditions,
    synthetic,
    ctx,
    isoToEpochMillis(SYNTHETIC_BASE.created_at),
  );
  return verdict !== 'false';
}

function linksTo(from: RuleNode, to: RuleNode): boolean {
  if (to.trigger !== 'task_created') return false;
  return from.actions.some((action) => couldMatchSpawn(to.conditions, action));
}

/**
 * Validates a rule at creation/update time: actions + conditions schemas
 * (E_PARSE) and transitive self-trigger safety (E_RULE_SELF_TRIGGER).
 */
export function validateAutomationRule(
  candidate: RuleCandidate,
  existingRules: readonly AutomationRule[] = [],
): Result<void> {
  const actions = automationActionsSchema.safeParse(candidate.actions);
  if (!actions.success) {
    const first = actions.error.issues[0];
    return err(
      domainError('E_PARSE', `invalid actions: ${first?.message ?? 'malformed'}`),
    );
  }
  const conditions = predicateSchema.safeParse(candidate.conditions);
  if (!conditions.success) {
    return err(domainError('E_PARSE', 'invalid conditions: not a §9.2 predicate'));
  }
  // §10.3/V10 (S5-F10): automation conditions may not read external facts. The
  // server's automation path never loads `external_facts`, so a weather-
  // conditioned rule can NEVER fire — reject it at authoring time rather than
  // let the user create a rule that silently does nothing.
  if (referencesExternalFacts(candidate.conditions)) {
    return err(
      domainError(
        'E_EXTERNAL_FACT_CONDITION',
        'automation conditions cannot reference external facts (e.g. weather); they never fire server-side (§10.3). Use a blocker rule for advisory weather display.',
      ),
    );
  }
  // S3-F7: cap `matches` pattern length at authoring time (ReDoS guard). The
  // evaluator also fails safe above the cap, so blocker rules are covered at eval
  // time even though blocker.create has no core validator to reject them here.
  if (hasOverlongMatchesPattern(candidate.conditions)) {
    return err(
      domainError(
        'E_PATTERN_TOO_LONG',
        `a "matches" pattern exceeds ${MAX_MATCHES_PATTERN_LENGTH} characters (§9.2 pattern-complexity cap).`,
      ),
    );
  }

  const candidateNode: RuleNode = {
    id: '__candidate__',
    trigger: candidate.trigger,
    conditions: candidate.conditions,
    actions: actions.data,
  };
  const others: RuleNode[] = [];
  for (const rule of existingRules) {
    if (rule.deleted_at !== null || !rule.enabled) continue;
    const parsed = automationActionsSchema.safeParse(rule.actions);
    if (!parsed.success) continue; // cannot spawn ⇒ cannot participate in a cycle
    others.push({
      id: rule.id,
      trigger: rule.trigger,
      conditions: rule.conditions,
      actions: parsed.data,
    });
  }
  const all = [candidateNode, ...others];

  // Can a chain of spawns starting from the candidate re-trigger it?
  const visited = new Set<string>();
  const stack = all.filter((node) => linksTo(candidateNode, node));
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === candidateNode.id) {
      return err(
        domainError(
          'E_RULE_SELF_TRIGGER',
          'this rule could re-trigger itself (directly or through other rules); ' +
            'narrow its conditions or the spawned titles (§9.1)',
        ),
      );
    }
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    for (const next of all) {
      if (linksTo(node, next)) stack.push(next);
    }
  }
  return ok(undefined);
}
