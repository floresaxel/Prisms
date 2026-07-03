/**
 * The shared predicate AST evaluator (§9.2) — used by blocker rules here and
 * by automation conditions in the rules engine (s07).
 *
 * Tri-state logic: a leaf whose fact cannot be resolved (absent weather row
 * offline, unknown fact path, malformed AST) evaluates `unknown`, and
 * `unknown` propagates through all/any/not unless short-circuited. Blocker
 * rules treat a top-level `unknown` as NOT blocked, surfaced to the UI as
 * "unverified" (§9.2 graceful degradation, principle 5).
 *
 * Fact registry (resolvers read only synced rows — identical on device and
 * server):
 * - node.title | node.type | node.description     string
 * - node.start_date | node.due_date               IsoDate (unknown when null)
 * - node.estimate_minutes                         number (unknown when null)
 * - node.completed                                boolean
 * - node.habit_id                                 string (unknown when null)
 * - ancestor.type                                 string[] (existential ops)
 * - project.phase                                 phase of the nearest
 *                                                 ancestor-or-self project
 * - graph.unfinished_predecessors                 number
 * - date.window                                   today (§7.2 bucketed date)
 * - weather.<field> (key: template)               payload field of the
 *                                                 matching external_facts row
 *
 * Key templates interpolate `{today}` and `{block_date}`; an unresolvable
 * variable makes the leaf `unknown`.
 */
import { z } from 'zod';

import type { BlockerRule, Node } from '../domain/entities';
import { nodeTypeSchema } from '../domain/entities';
import {
  jsonValueSchema,
  uuidSchema,
  type IsoDate,
  type JsonValue,
} from '../domain/primitives';
import { incomingEdges } from '../graph/dag';
import { ancestorsOf, getNode } from '../graph/tree';
import type { Instant } from '../time/instant';

import type { FactContext } from './context';
import { projectPhase } from './phase';

// --- AST schemas -------------------------------------------------------------

export const predicateOpSchema = z.enum([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'matches',
  'inside',
  'outside',
]);
export type PredicateOp = z.infer<typeof predicateOpSchema>;

const conditionSchema = z.strictObject({
  fact: z.string().min(1),
  op: predicateOpSchema,
  value: jsonValueSchema.optional(),
  key: z.string().optional(),
});
export type PredicateCondition = z.infer<typeof conditionSchema>;

export type PredicateNode =
  | { all: PredicateNode[] }
  | { any: PredicateNode[] }
  | { not: PredicateNode }
  | PredicateCondition;

// all([]) ≡ 'true' and any([]) ≡ 'false' (vacuous truth) — `{all: []}` is the
// canonical "always" predicate for automation rules that fire unconditionally.
export const predicateSchema: z.ZodType<PredicateNode> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(predicateSchema) }),
    z.strictObject({ any: z.array(predicateSchema) }),
    z.strictObject({ not: predicateSchema }),
    conditionSchema,
  ]),
);

/**
 * Fact namespaces whose values come from an external provider (weather today;
 * future providers add their prefix here). External-fact-derived state is
 * advisory display only (§10.3, R19/V10): it must never gate command acceptance
 * and must never change a convergent outcome.
 */
export const EXTERNAL_FACT_PREFIXES = ['weather.'] as const;

const isExternalFact = (fact: string): boolean =>
  EXTERNAL_FACT_PREFIXES.some((prefix) => fact.startsWith(prefix));

function walkForExternalFact(node: PredicateNode): boolean {
  if ('all' in node) return node.all.some(walkForExternalFact);
  if ('any' in node) return node.any.some(walkForExternalFact);
  if ('not' in node) return walkForExternalFact(node.not);
  return isExternalFact(node.fact);
}

/**
 * True if any leaf condition in `predicate` reads an external-fact namespace
 * (§10.3). Used to (a) exclude weather-reading blocker rules from the
 * acceptance-safe gate (`isBlockedForAcceptance`, status.ts) and (b) reject
 * automation conditions that reference external facts (they can never fire
 * server-side — S5-F10 — since jobs never load `external_facts`). A malformed
 * predicate parses to nothing and returns false (it cannot fire regardless).
 */
export function referencesExternalFacts(predicate: unknown): boolean {
  const parsed = predicateSchema.safeParse(predicate);
  return parsed.success ? walkForExternalFact(parsed.data) : false;
}

/**
 * Max length of a `matches` regex pattern (§9.2, S3-F7). The `matches` op compiles
 * `new RegExp(value)` over untrusted, user-authored input, so an overlong pattern
 * is a ReDoS surface. The cap is enforced in two places: at authoring time
 * (`hasOverlongMatchesPattern`, used by validate.ts to REJECT automation rules) and
 * at evaluation time (the `matches` case fails safe to `unknown` above the cap),
 * so blocker rules and any already-stored pattern are covered without recompiling.
 */
export const MAX_MATCHES_PATTERN_LENGTH = 200;

function walkForLongMatch(node: PredicateNode): boolean {
  if ('all' in node) return node.all.some(walkForLongMatch);
  if ('any' in node) return node.any.some(walkForLongMatch);
  if ('not' in node) return walkForLongMatch(node.not);
  return node.op === 'matches' && typeof node.value === 'string' && node.value.length > MAX_MATCHES_PATTERN_LENGTH;
}

/**
 * True if any `matches` leaf carries a pattern longer than the cap (S3-F7). A
 * malformed predicate parses to nothing → false (it can't evaluate regardless).
 */
export function hasOverlongMatchesPattern(predicate: unknown): boolean {
  const parsed = predicateSchema.safeParse(predicate);
  return parsed.success ? walkForLongMatch(parsed.data) : false;
}

/**
 * blocker_rules.scope (§6.0): which nodes a rule applies to. All fields
 * optional; omitted node_types defaults to tasks only.
 */
export const blockerScopeSchema = z.strictObject({
  node_types: z.array(nodeTypeSchema).min(1).optional(),
  subtree_of: uuidSchema.optional(),
});
export type BlockerScope = z.infer<typeof blockerScopeSchema>;

// --- evaluation --------------------------------------------------------------

export type TriBool = 'true' | 'false' | 'unknown';

export interface PredicateInterpolation {
  /** Set when evaluating in a block context (scheduler, §9.2 example). */
  block_date?: IsoDate;
}

type FactValue = string | number | boolean;
type ResolvedFact =
  | { kind: 'value'; value: FactValue }
  | { kind: 'multi'; values: FactValue[] }
  | { kind: 'unknown' };

const UNKNOWN: ResolvedFact = { kind: 'unknown' };
const value = (v: FactValue): ResolvedFact => ({ kind: 'value', value: v });

function interpolateKey(
  template: string,
  today: IsoDate,
  interp: PredicateInterpolation,
): string | undefined {
  let unresolved = false;
  const out = template.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (name === 'today') return today;
    if (name === 'block_date' && interp.block_date !== undefined) {
      return interp.block_date;
    }
    unresolved = true;
    return '';
  });
  return unresolved ? undefined : out;
}

function resolveFact(
  condition: PredicateCondition,
  subject: Node,
  ctx: FactContext,
  now: Instant,
  interp: PredicateInterpolation,
): ResolvedFact {
  const { fact } = condition;

  if (fact.startsWith('weather.')) {
    const field = fact.slice('weather.'.length);
    const keyTemplate = condition.key ?? '{today}';
    const key = interpolateKey(keyTemplate, ctx.today(now), interp);
    if (key === undefined) return UNKNOWN;
    const row = ctx.weatherFact(key);
    if (!row) return UNKNOWN;
    const payload = row.payload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return UNKNOWN;
    }
    const fieldValue: JsonValue | undefined = payload[field];
    if (
      typeof fieldValue === 'string' ||
      typeof fieldValue === 'number' ||
      typeof fieldValue === 'boolean'
    ) {
      return value(fieldValue);
    }
    return UNKNOWN;
  }

  switch (fact) {
    case 'node.title':
      return value(subject.title);
    case 'node.type':
      return value(subject.node_type);
    case 'node.description':
      return value(subject.description);
    case 'node.start_date':
      return subject.start_date === null ? UNKNOWN : value(subject.start_date);
    case 'node.due_date':
      return subject.due_date === null ? UNKNOWN : value(subject.due_date);
    case 'node.estimate_minutes':
      return subject.estimate_minutes === null
        ? UNKNOWN
        : value(subject.estimate_minutes);
    case 'node.completed':
      return value(subject.completed_at !== null);
    case 'node.habit_id':
      return subject.habit_id === null ? UNKNOWN : value(subject.habit_id);
    case 'ancestor.type':
      return {
        kind: 'multi',
        values: ancestorsOf(ctx.tree, subject.id).map((a) => a.node_type),
      };
    case 'project.phase': {
      const project =
        subject.node_type === 'project'
          ? subject
          : ancestorsOf(ctx.tree, subject.id).find((a) => a.node_type === 'project');
      return project ? value(projectPhase(project.id, ctx, now)) : UNKNOWN;
    }
    case 'graph.unfinished_predecessors': {
      let count = 0;
      for (const edge of incomingEdges(ctx.edgeIndex, subject.id)) {
        const predecessor = getNode(ctx.tree, edge.predecessor_id);
        if (predecessor && predecessor.completed_at === null) count += 1;
      }
      return value(count);
    }
    case 'date.window':
      return value(ctx.today(now));
    default:
      return UNKNOWN;
  }
}

const triNot = (v: TriBool): TriBool =>
  v === 'unknown' ? 'unknown' : v === 'true' ? 'false' : 'true';

function compareSingle(op: PredicateOp, fact: FactValue, expected: JsonValue | undefined): TriBool {
  switch (op) {
    case 'eq':
    case 'ne': {
      if (expected === null || typeof expected === 'object') return 'unknown';
      if (expected === undefined) return 'unknown';
      const eq = fact === expected ? 'true' : 'false';
      return op === 'eq' ? eq : triNot(eq);
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const comparable =
        (typeof fact === 'number' && typeof expected === 'number') ||
        (typeof fact === 'string' && typeof expected === 'string');
      if (!comparable) return 'unknown';
      const f = fact as number | string;
      const e = expected as number | string;
      const result =
        op === 'gt' ? f > e : op === 'gte' ? f >= e : op === 'lt' ? f < e : f <= e;
      return result ? 'true' : 'false';
    }
    case 'matches': {
      if (typeof fact !== 'string' || typeof expected !== 'string') return 'unknown';
      // S3-F7: refuse to compile an overlong (ReDoS-surface) pattern; fail safe.
      if (expected.length > MAX_MATCHES_PATTERN_LENGTH) return 'unknown';
      try {
        return new RegExp(expected, 'i').test(fact) ? 'true' : 'false';
      } catch {
        return 'unknown'; // invalid pattern — fail safe
      }
    }
    case 'inside':
    case 'outside': {
      if (typeof fact !== 'string') return 'unknown';
      if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
        return 'unknown';
      }
      const start = expected['start'];
      const end = expected['end'];
      if (start !== undefined && typeof start !== 'string') return 'unknown';
      if (end !== undefined && typeof end !== 'string') return 'unknown';
      const inside =
        (start === undefined || fact >= start) && (end === undefined || fact <= end);
      const asTri: TriBool = inside ? 'true' : 'false';
      return op === 'inside' ? asTri : triNot(asTri);
    }
  }
}

/** Multi-valued facts (ancestor.type) quantify existentially; ne/outside are the negations. */
function compare(op: PredicateOp, fact: ResolvedFact, expected: JsonValue | undefined): TriBool {
  if (fact.kind === 'unknown') return 'unknown';
  if (fact.kind === 'value') return compareSingle(op, fact.value, expected);

  const positiveOp: PredicateOp = op === 'ne' ? 'eq' : op === 'outside' ? 'inside' : op;
  let sawUnknown = false;
  for (const v of fact.values) {
    const r = compareSingle(positiveOp, v, expected);
    if (r === 'true') return op === 'ne' || op === 'outside' ? 'false' : 'true';
    if (r === 'unknown') sawUnknown = true;
  }
  if (sawUnknown) return 'unknown';
  return op === 'ne' || op === 'outside' ? 'true' : 'false';
}

function evalNode(
  node: PredicateNode,
  subject: Node,
  ctx: FactContext,
  now: Instant,
  interp: PredicateInterpolation,
): TriBool {
  if ('all' in node) {
    let sawUnknown = false;
    for (const child of node.all) {
      const r = evalNode(child, subject, ctx, now, interp);
      if (r === 'false') return 'false';
      if (r === 'unknown') sawUnknown = true;
    }
    return sawUnknown ? 'unknown' : 'true';
  }
  if ('any' in node) {
    let sawUnknown = false;
    for (const child of node.any) {
      const r = evalNode(child, subject, ctx, now, interp);
      if (r === 'true') return 'true';
      if (r === 'unknown') sawUnknown = true;
    }
    return sawUnknown ? 'unknown' : 'false';
  }
  if ('not' in node) {
    return triNot(evalNode(node.not, subject, ctx, now, interp));
  }
  return compare(node.op, resolveFact(node, subject, ctx, now, interp), node.value);
}

/** Parses and evaluates an untrusted predicate AST; malformed → `unknown`. */
export function evalPredicate(
  predicate: unknown,
  subject: Node,
  ctx: FactContext,
  now: Instant,
  interp: PredicateInterpolation = {},
): TriBool {
  const parsed = predicateSchema.safeParse(predicate);
  if (!parsed.success) return 'unknown';
  return evalNode(parsed.data, subject, ctx, now, interp);
}

/** Malformed scope applies to nothing (fail-safe); omitted node_types = tasks. */
export function inScope(scope: unknown, subject: Node, ctx: FactContext): boolean {
  const parsed = blockerScopeSchema.safeParse(scope);
  if (!parsed.success) return false;
  const nodeTypes = parsed.data.node_types ?? ['task'];
  if (!nodeTypes.includes(subject.node_type)) return false;
  const root = parsed.data.subtree_of;
  if (root !== undefined) {
    if (subject.id !== root && !ancestorsOf(ctx.tree, subject.id).some((a) => a.id === root)) {
      return false;
    }
  }
  return true;
}

export interface BlockerEvaluation {
  blocked: boolean;
  /** Rules that evaluated `true`. */
  blockedBy: readonly BlockerRule[];
  /** In-scope rules that evaluated `unknown` — UI shows e.g. "weather unverified". */
  unverified: readonly BlockerRule[];
}

export function evaluateBlockerRules(
  subject: Node,
  ctx: FactContext,
  now: Instant,
  interp: PredicateInterpolation = {},
  opts: { excludeExternalFacts?: boolean } = {},
): BlockerEvaluation {
  const blockedBy: BlockerRule[] = [];
  const unverified: BlockerRule[] = [];
  for (const rule of ctx.enabledBlockerRules()) {
    if (!inScope(rule.scope, subject, ctx)) continue;
    // §10.3/R19: on the acceptance-safe path, a rule that reads any external
    // fact (weather) is skipped entirely — external state must never gate a
    // command. The full evaluation (display path) still surfaces it as
    // blocked/unverified. Skipping the whole rule (not just the weather leaf)
    // guarantees weather can never contribute to a rejection.
    if (opts.excludeExternalFacts && referencesExternalFacts(rule.predicate)) continue;
    const result = evalPredicate(rule.predicate, subject, ctx, now, interp);
    if (result === 'true') blockedBy.push(rule);
    else if (result === 'unknown') unverified.push(rule);
  }
  return { blocked: blockedBy.length > 0, blockedBy, unverified };
}
