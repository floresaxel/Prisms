/**
 * Which tables a watched query reads — taken from the SQL text instead of asked
 * of SQLite.
 *
 * PowerSync re-runs a watched query when one of its tables changes, so it has to
 * know the tables before it can run the query at all. Left to itself it finds
 * out with two extra statements per watch — `EXPLAIN <sql>`, then a
 * `sqlite_master` lookup of the root pages that EXPLAIN opened — and every
 * statement is a round-trip to the database worker, queued behind all the others
 * on the one connection. A cold load opens ~30 watches, so ~60 round-trips
 * (≈245 ms measured on the web build) ran before the first real SELECT did.
 *
 * `useQuery` cannot be told the tables: @powersync/react forwards only
 * `reportFetching`/`rowComparator` to the watch, never `triggerOnTables`. But
 * every watch asks the database through `resolveTables`, so that is where this
 * answers.
 *
 * Every watch in this app is a plain single-table SELECT, which names its table
 * in its own text, and reading it there is exact for that shape. Anything else —
 * a join, a subquery, a table this schema does not have — is left to EXPLAIN, so
 * the worst case is the old cost and never a watch that misses a change.
 */

/** A table name right after the query's only FROM, with nothing joined to it. */
const SELECT_FROM = /^\s*select\b[^;]*?\bfrom\s+([a-z_][a-z0-9_]*)(?![\w.]|\s*[,(])/i;
const ANY_FROM = /\bfrom\b/gi;
/** More than one source: each of these needs the real query plan. */
const COMPOUND = /\b(join|union|intersect|except)\b/i;

/**
 * The table a single-table SELECT reads, or `null` when the text is anything
 * this cannot be sure about. `known` is the schema's table names: a name outside
 * it (a typo, a view, a table-valued function) is never guessed at.
 */
export function tablesFromSql(sql: string, known: ReadonlySet<string>): string[] | null {
  // Exactly one FROM: a second one is a subquery — or the word inside a string
  // literal, which is indistinguishable here and just as good a reason to ask.
  if ((sql.match(ANY_FROM) ?? []).length !== 1 || COMPOUND.test(sql)) return null;
  const table = SELECT_FROM.exec(sql)?.[1]?.toLowerCase();
  return table !== undefined && known.has(table) ? [table] : null;
}

/** The one method this replaces, as every PowerSync database (web, native) has it. */
export interface ResolvesTables {
  resolveTables(sql: string, parameters?: unknown[], options?: { tables?: string[] }): Promise<string[]>;
}

/**
 * Make `db` resolve a watch's tables from its SQL text where that is exact, and
 * through its own EXPLAIN lookup everywhere else. Tables a caller passes
 * explicitly are still taken as given. Returns the same `db`.
 */
export function watchTablesFromSql<T extends ResolvesTables>(db: T, known: Iterable<string>): T {
  const names = new Set(known);
  // Read off the instance lazily, at call time: a database that never watches
  // anything (a test double) does not need to have the method at all.
  const viaExplain = db.resolveTables;
  db.resolveTables = function resolveTables(this: T, sql, parameters, options) {
    const fromText = options?.tables ? null : tablesFromSql(sql, names);
    return fromText ? Promise.resolve(fromText) : viaExplain.call(this, sql, parameters, options);
  };
  return db;
}
