/**
 * Versioning primitives (1.3 §7.11 row schema versioning, §8 command versioning).
 * PURE (§16). M1 defines the primitives; M3 stamps rows, M5 enforces the floor.
 *
 * Two independent version axes:
 *  - ROW schema_version — the shape of a synced row; additive-only within a
 *    major version; old clients ignore unknown downloaded columns.
 *  - COMMAND command_version / payload-schema-version — the wire shape of a
 *    command payload; payloads may only gain OPTIONAL fields within a version.
 */
import { domainError, type DomainError } from '../domain/errors';
import type { Uuid } from '../domain/primitives';
import { err, ok, type Result } from '../domain/result';

/** Current row-shape floor (§7.11). Legacy rows backfill to this; new rows >= it. */
export const ROW_SCHEMA_VERSION = 1;

/** Current command-payload version (§8). Bumped only on a breaking payload change. */
export const COMMAND_VERSION = 1;

/** Intra-device causal dependencies of a command (§7.2e). */
export type DependsOn = readonly Uuid[];

/** Envelope version metadata the server records on `command_log` (§7.2f). */
export interface CommandMeta {
  readonly command_version: number;
  readonly schema_version: number;
  readonly client_version?: string;
  readonly depends_on: DependsOn;
}

/** Default version metadata for a freshly-minted command. */
export function defaultCommandMeta(depends_on: DependsOn = []): CommandMeta {
  return { command_version: COMMAND_VERSION, schema_version: ROW_SCHEMA_VERSION, depends_on };
}

/** One column's shape, for the additive-only check. */
export interface ColumnSpec {
  readonly type: string;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
}
export type TableShape = Readonly<Record<string, ColumnSpec>>;

/**
 * Additive-only check (§7.11). Within a major schema version a change may only
 * ADD nullable columns or columns with a DB default. Removing a column, changing
 * a type, tightening nullable → NOT NULL, or adding a NOT-NULL column without a
 * default is breaking and requires a major bump + an explicit migrator.
 */
export function isAdditiveSchemaChange(prev: TableShape, next: TableShape): Result<void, DomainError> {
  const breaking: string[] = [];
  for (const [col, spec] of Object.entries(prev)) {
    const after = next[col];
    if (!after) breaking.push(`removed column "${col}"`);
    else if (after.type !== spec.type) breaking.push(`type change on "${col}" (${spec.type} → ${after.type})`);
    else if (!after.nullable && spec.nullable) breaking.push(`tightened "${col}" to NOT NULL`);
  }
  for (const [col, spec] of Object.entries(next)) {
    if (col in prev) continue;
    if (!spec.nullable && !spec.hasDefault) breaking.push(`new NOT-NULL column "${col}" without a default`);
  }
  return breaking.length === 0
    ? ok(undefined)
    : err(domainError('E_SCHEMA_NOT_ADDITIVE', `non-additive schema change: ${breaking.join('; ')}`, { breaking }));
}

/**
 * §7.11 floor gate: the server records the minimum row schema_version it still
 * accepts commands from. A command below the floor is rejected `client_too_old`
 * (E_CLIENT_TOO_OLD) with a review item — never applied by guesswork (M5).
 */
export function isClientTooOld(clientSchemaVersion: number, floor: number): boolean {
  return clientSchemaVersion < floor;
}
