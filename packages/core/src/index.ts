/**
 * @prisms/core — pure domain logic for Prisms.
 *
 * Rules of this package (ARCHITECTURE.md §2 principle 4, §16):
 * - No IO, no platform APIs, no wall clock, no randomness.
 * - Clock and Rng are injected parameters.
 * - Imports nothing from other workspace packages.
 *
 * Module map:
 * - domain/      entity types + Zod schemas, Result/DomainError, id helpers (s02)
 * - time/        instants, Clock/Rng, HLC, day bucketing, duration math (s02)
 * - graph/       tree/DAG ops, sort order, invariants I1–I4/I10, critical path (s04;
 *                ELK view-models arrive with the diagram surfaces, s14/s20)
 * - status/      derived status fn, project phase, predicate AST (s05)
 * - aggregates/  effective/practice hours, streaks, progress, completion,
 *                burndown + projection, time-left (s06)
 * - rules/       automation engine: spawn templates, fixpoint, UUIDv5
 *                outputs, self-trigger validation (s07; blockers live in
 *                status/predicate since they share the §9.2 evaluator)
 * - scheduler/   greedy earliest-fit placement, window hints, reschedule
 *                (s08); optimize-mode local search + diffing (s09)
 * - commands/    envelope + settings.update (s10); TODO(s11) full catalog +
 *                invariant checks
 */
export const CORE_PACKAGE = '@prisms/core' as const;

export * from './domain/errors';
export * from './domain/result';
export * from './domain/primitives';
export * from './domain/entities';
export * from './domain/ids';
export * from './time/instant';
export * from './time/dates';
export * from './time/clock';
export * from './time/rng';
export * from './time/duration';
export * from './time/hlc';
export * from './time/bucket';
export * from './graph/tree';
export * from './graph/order';
export * from './graph/hierarchy';
export * from './graph/justify';
export * from './graph/cascade';
export * from './graph/dag';
export * from './graph/critical-path';
export * from './graph/elk';
export * from './commands/envelope';
export * from './commands/settings';
export * from './commands/payloads';
export * from './commands/invariants';
export * from './commands/timer-merge';
export * from './status/context';
export * from './status/phase';
export * from './status/predicate';
export * from './status/status';
export * from './aggregates/effective';
export * from './aggregates/occurrences';
export * from './aggregates/practice';
export * from './aggregates/progress';
export * from './aggregates/completion';
export * from './aggregates/streaks';
export * from './aggregates/burndown';
export * from './aggregates/timeleft';
export * from './rules/actions';
export * from './rules/engine';
export * from './rules/validate';
export * from './scheduler/types';
export * from './scheduler/windows';
export * from './scheduler/greedy';
export * from './scheduler/optimize';
