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
 * - graph/       TODO(s04) tree/DAG ops, cycle detection
 * - status/      TODO(s05) derived status + predicate AST
 * - aggregates/  TODO(s06) streaks, practice hours, progress, burndown
 * - rules/       TODO(s07) automation + blocker rules engine
 * - scheduler/   TODO(s08, s09) greedy + optimize scheduling
 * - commands/    TODO(s11) mutation catalog payload schemas + invariant checks
 */
export const CORE_PACKAGE = '@prisms/core' as const;

export * from './domain/errors';
export * from './domain/result';
export * from './domain/primitives';
export * from './domain/entities';
export * from './domain/ids';
export * from './time/instant';
export * from './time/clock';
export * from './time/rng';
export * from './time/duration';
export * from './time/hlc';
export * from './time/bucket';
