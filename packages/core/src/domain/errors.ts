/**
 * Typed domain errors (ARCHITECTURE.md §8, §16).
 *
 * Core never throws strings; every fallible domain operation returns
 * `Result<T, DomainError>` with a machine-readable code. The same codes
 * travel over the command API as rejection reasons.
 *
 * Invariant → code mapping (§6.7):
 * - I1 hierarchy typing            → E_HIERARCHY
 * - I2 max 4 visions               → E_MAX_VISIONS
 * - I3 justification xor           → E_JUSTIFICATION
 * - I4 DAG / same-type edges       → E_CYCLE, E_EDGE_TYPE_MISMATCH
 * - I5 one open time entry         → E_TIMER_ALREADY_RUNNING
 * - I6 ends_at > starts_at         → E_INVALID_INTERVAL
 * - I7 anchored blocks immutable   → E_ANCHORED_IMMUTABLE
 * - I8 done tasks immutable        → E_DONE_IMMUTABLE
 * - I9 suggestion overlaps anchor  → E_SUGGESTION_OVERLAPS_ANCHOR
 * (I10 soft-delete cascade is behavior, not an error.)
 */
export const ERROR_CODES = [
  // command pipeline (§8)
  'E_PARSE',
  'E_UNKNOWN_COMMAND',
  'E_OWNERSHIP',
  'E_NOT_FOUND',
  'E_DUPLICATE',
  'E_RATE_LIMITED',
  // invariants (§6.7)
  'E_HIERARCHY',
  'E_MAX_VISIONS',
  'E_JUSTIFICATION',
  'E_CYCLE',
  'E_EDGE_TYPE_MISMATCH',
  'E_TIMER_ALREADY_RUNNING',
  'E_TIMER_NOT_RUNNING',
  'E_INVALID_INTERVAL',
  'E_ANCHORED_IMMUTABLE',
  'E_DONE_IMMUTABLE',
  'E_SUGGESTION_OVERLAPS_ANCHOR',
  // rules engine (§9)
  'E_RULE_SELF_TRIGGER',
  'E_RULE_DEPTH_EXCEEDED',
  // catch-all for bugs surfaced as data (never expected in normal operation)
  'E_INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface DomainError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

export function domainError(
  code: ErrorCode,
  message: string,
  details?: unknown,
): DomainError {
  return details === undefined ? { code, message } : { code, message, details };
}
