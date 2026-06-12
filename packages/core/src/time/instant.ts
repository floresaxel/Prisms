/**
 * Instants as branded epoch milliseconds.
 *
 * Core does arithmetic on epoch ms (deterministic, timezone-free) and only
 * touches calendar concepts through `bucketDate` (§7.2). The brand prevents
 * mixing raw numbers / minute counts into instant positions.
 */
import type { IsoDateTime } from '../domain/primitives';

declare const epochMillisBrand: unique symbol;
export type EpochMillis = number & { readonly [epochMillisBrand]: true };

/** §7.1 vocabulary: the status function takes `now: Instant`. */
export type Instant = EpochMillis;

export function asEpochMillis(ms: number): EpochMillis {
  if (!Number.isSafeInteger(ms)) {
    throw new TypeError(`asEpochMillis: expected a safe integer, got ${ms}`);
  }
  return ms as EpochMillis;
}

/** Parses an ISO 8601 datetime (schema-validated upstream). Throws TypeError on garbage — that is a bug, not a domain error. */
export function isoToEpochMillis(iso: IsoDateTime): EpochMillis {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) {
    throw new TypeError(`isoToEpochMillis: unparseable datetime "${iso}"`);
  }
  return ms as EpochMillis;
}

/** Canonical UTC ('Z') ISO form. */
export function epochMillisToIso(ms: EpochMillis): IsoDateTime {
  return new Date(ms).toISOString();
}

/** Accepts either representation; all time/ functions take this union. */
export function toEpochMillis(ts: EpochMillis | IsoDateTime): EpochMillis {
  return typeof ts === 'string' ? isoToEpochMillis(ts) : ts;
}
