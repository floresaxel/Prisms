/**
 * @prisms/core — pure domain logic for Prisms.
 *
 * Rules of this package (ARCHITECTURE.md §2 principle 4, §16):
 * - No IO, no platform APIs, no wall clock, no randomness.
 * - Clock and Rng are injected parameters (arrive in s02).
 * - Imports nothing from other workspace packages.
 *
 * Module map (built in later sessions):
 * - domain/      TODO(s02) entity types + Zod schemas
 * - time/        TODO(s02) HLC, day-reset bucketing, duration math
 * - graph/       TODO(s04) tree/DAG ops, cycle detection
 * - status/      TODO(s05) derived status + predicate AST
 * - aggregates/  TODO(s06) streaks, practice hours, progress, burndown
 * - rules/       TODO(s07) automation + blocker rules engine
 * - scheduler/   TODO(s08, s09) greedy + optimize scheduling
 * - commands/    TODO(s11 catalog schemas live here from s02 on)
 */
export const CORE_PACKAGE = '@prisms/core' as const;
