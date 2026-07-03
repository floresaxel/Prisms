/**
 * Persistent client read layer (1.4 §7.14, Fix A; M11).
 *
 * v1.0 mounted every screen's reactive subscriptions per navigation: a single
 * screen could open 12+ `SELECT *` watches, and `useFactContext` fanned out 9 of
 * them, so a tab switch cold-re-subscribed and rebuilt the fact/tree index every
 * time (the visible read-path flash).
 *
 * `PrismsDataProvider` is mounted ONCE above the router (inside
 * `PowerSyncContext.Provider`, above the route switch) and owns, for the whole
 * authenticated session:
 *   - one merged (replica + overlay) subscription per provider-shared table (the
 *     9 base tables of the Table→Owner Matrix), plus a single `overlay_effects`
 *     subscription partitioned in memory (so the merge stays the two-layer read
 *     of §7.2 without a per-table overlay watch);
 *   - the derived `FactContext`/`TreeIndex`, built once and memoized on the row
 *     sets — NOT rebuilt on navigation or on the 1s `now` tick.
 * Screens read this warm context by reference; navigating creates/closes no
 * shared subscription and re-runs no base derivation.
 *
 * It does NOT change the db identity used by writers: `createCommands` still
 * binds to the live `usePowerSync()` db (M8), so the command-envelope upload and
 * overlay rollback are unchanged. A later §7.12 `StatusIndex` would live here as a
 * single session-scoped member (status is still computed live in selectors today).
 */
import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';

import { useQuery, useStatus } from '@powersync/react';
import { asEpochMillis, mergeTable, StatusIndex, type FactContext, type FactRows, type OverlayEffect, type StatusEffect, type TreeIndex } from '@prisms/core';

import {
  toBlockerRule,
  toEdge,
  toExternalFact,
  toMembership,
  toNode,
  toScheduleBlock,
  toSprint,
  toTimeEntry,
  toUserSettings,
} from './rows';

type Row = Record<string, unknown>;

/** Parse an `overlay_effects` row into the pure-core effect shape (shared with `useRows`). */
export const toOverlayEffect = (r: Row): OverlayEffect => {
  const raw = r['fields'];
  let fields: OverlayEffect['fields'] = {};
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      fields = JSON.parse(raw) as OverlayEffect['fields'];
    } catch {
      fields = {};
    }
  }
  return {
    command_id: String(r['command_id']),
    hlc: String(r['hlc']),
    table: String(r['table_name']),
    row_id: String(r['row_id']),
    op: r['op'] as OverlayEffect['op'],
    fields,
    seq: Number(r['seq'] ?? 0),
  };
};

// --- incremental FactContext engine (§7.12/§7.14, S8-F1) --------------------
//
// v1.0/M11 rebuilt the ENTIRE FactContext (`buildFactContext`, ~65ms at 100k) on
// every change to the merged rows — and every optimistic write changes the
// overlay, so it ran per keystroke. This engine seeds a `StatusIndex` ONCE, then
// feeds it the minimal diff of the merged rows on each change (apply is O(dirty),
// ~0.02ms) and hands consumers a FRESH FactContext identity over the live maps.
// The diff is correct-by-construction: it always reconciles the index to the
// current merged rows, so reconcile/rollback need no special handling.

/** The index needs a `now` for a status pass it does not run in view-only mode. */
const SEED_NOW = asEpochMillis(0);
/** A change larger than this reseeds (a big sync-down) rather than applying deltas. */
const REBUILD_THRESHOLD = 5000;

type Mapped = Record<string, unknown>;
const asFields = (o: unknown): StatusEffect['fields'] => o as StatusEffect['fields'];

/** The 8 id-keyed shared tables and their raw→core mappers (user_settings is special). */
const SHARED_TABLES: ReadonlyArray<{ key: keyof SharedRows; table: string; map: (r: Row) => Mapped }> = [
  { key: 'nodes', table: 'nodes', map: (r) => toNode(r) as unknown as Mapped },
  { key: 'edges', table: 'edges', map: (r) => toEdge(r) as unknown as Mapped },
  { key: 'time_entries', table: 'time_entries', map: (r) => toTimeEntry(r) as unknown as Mapped },
  { key: 'schedule_blocks', table: 'schedule_blocks', map: (r) => toScheduleBlock(r) as unknown as Mapped },
  { key: 'sprints', table: 'sprints', map: (r) => toSprint(r) as unknown as Mapped },
  { key: 'sprint_memberships', table: 'sprint_memberships', map: (r) => toMembership(r) as unknown as Mapped },
  { key: 'blocker_rules', table: 'blocker_rules', map: (r) => toBlockerRule(r) as unknown as Mapped },
  { key: 'external_facts', table: 'external_facts', map: (r) => toExternalFact(r) as unknown as Mapped },
];

interface Engine {
  index: StatusIndex | null;
  /** Per table: active row id → { raw (for identity diff), mapped (core entity) }. */
  tables: Map<string, Map<string, { raw: Row; mapped: Mapped }>>;
  /** Last settings row identity (to detect a settings change). */
  settingsRaw: Row | undefined;
}

/** Diff a table's current active rows against the prior state → minimal effects. */
function diffTable(
  prev: Map<string, { raw: Row; mapped: Mapped }>,
  table: string,
  rows: readonly Row[],
  map: (r: Row) => Mapped,
): { effects: StatusEffect[]; next: Map<string, { raw: Row; mapped: Mapped }> } {
  const effects: StatusEffect[] = [];
  const next = new Map<string, { raw: Row; mapped: Mapped }>();
  const seen = new Set<string>();
  for (const raw of rows) {
    if (raw['deleted_at'] != null) continue; // tombstone: excluded (like buildFactContext)
    const id = String(raw['id']);
    seen.add(id);
    const p = prev.get(id);
    if (p && p.raw === raw) {
      next.set(id, p); // identity-stable row → unchanged, reuse the mapped entity
      continue;
    }
    const mapped = map(raw);
    next.set(id, { raw, mapped });
    effects.push({ table, op: p ? 'update' : 'insert', row_id: id, fields: asFields(mapped) });
  }
  for (const id of prev.keys()) if (!seen.has(id)) effects.push({ table, op: 'delete', row_id: id, fields: {} });
  return { effects, next };
}

/** Full (re)seed of the index + per-table state from the current merged rows. */
function seed(engine: Engine, rows: SharedRows): void {
  const factRows: Record<string, unknown> = {};
  engine.tables = new Map();
  for (const { key, table, map } of SHARED_TABLES) {
    const byId = new Map<string, { raw: Row; mapped: Mapped }>();
    const mapped: Mapped[] = [];
    for (const raw of rows[key]) {
      if (raw['deleted_at'] != null) continue;
      const m = map(raw);
      byId.set(String(raw['id']), { raw, mapped: m });
      mapped.push(m);
    }
    engine.tables.set(table, byId);
    factRows[key] = mapped;
  }
  const settingsRow = rows.user_settings[0];
  factRows['user_settings'] = settingsRow ? toUserSettings(settingsRow) : null;
  engine.index = new StatusIndex(factRows as unknown as FactRows, SEED_NOW, undefined, { trackStatus: false });
  engine.settingsRaw = settingsRow;
}

/** Maintain the index for the current merged rows and return a fresh FactContext. */
function maintain(engine: Engine, rows: SharedRows): FactContext {
  if (engine.index === null) {
    seed(engine, rows);
    return engine.index!.freshView();
  }
  const effects: StatusEffect[] = [];
  const nextTables = new Map<string, Map<string, { raw: Row; mapped: Mapped }>>();
  for (const { key, table, map } of SHARED_TABLES) {
    const prev = engine.tables.get(table) ?? new Map();
    const { effects: e, next } = diffTable(prev, table, rows[key], map);
    for (const ef of e) effects.push(ef);
    nextTables.set(table, next);
  }
  const settingsRow = rows.user_settings[0];
  if (settingsRow !== engine.settingsRaw && settingsRow) {
    effects.push({ table: 'user_settings', op: 'update', row_id: 'settings', fields: asFields(toUserSettings(settingsRow)) });
  }
  if (effects.length > REBUILD_THRESHOLD) {
    seed(engine, rows); // a big change (e.g. first sync-down) → cheaper to rebuild
  } else {
    if (effects.length) engine.index.apply(effects);
    engine.tables = nextTables;
    engine.settingsRaw = settingsRow;
  }
  return engine.index.freshView();
}

/** The provider-shared merged row sets (Table→Owner Matrix). Raw rows; consumers map. */
export interface SharedRows {
  /** UNFILTERED (incl. tombstones) so Dashboard's soft-delete-inclusive burndown works. */
  nodes: Row[];
  edges: Row[];
  time_entries: Row[];
  /** All active blocks (every status); consumers derive the `committed` view. */
  schedule_blocks: Row[];
  sprints: Row[];
  sprint_memberships: Row[];
  blocker_rules: Row[];
  external_facts: Row[];
  user_settings: Row[];
}

export interface PrismsData {
  /** The session-scoped fact context (built once, memoized on the shared rows). */
  factContext: FactContext;
  /** The session-scoped tree index (= `factContext.tree`). */
  tree: TreeIndex;
  /** The merged shared row sets. */
  rows: SharedRows;
  /** A shared subscription is refetching (any base table). */
  isFetching: boolean;
  /**
   * §7.14: first base result produced AND (PowerSync first sync complete this
   * session OR a base row already exists). Grounds M12's skeleton gating so a
   * fresh empty-replica login shows a skeleton, an offline populated reload does
   * not stick on one. Exposed here; consumed by the screens in M12 (Fix C).
   */
  isHydrated: boolean;
}

const PrismsDataContext = createContext<PrismsData | null>(null);

export function PrismsDataProvider({ children }: { children: ReactNode }) {
  const status = useStatus();

  // ONE overlay subscription for the whole store, partitioned by table in memory.
  const overlayQ = useQuery<Row>('SELECT command_id, hlc, table_name, row_id, op, fields, seq FROM overlay_effects');
  const overlayRows = overlayQ.data ?? [];
  const overlayByTable = useMemo(() => {
    const m = new Map<string, OverlayEffect[]>();
    for (const r of overlayRows) {
      const e = toOverlayEffect(r);
      const list = m.get(e.table);
      if (list) list.push(e);
      else m.set(e.table, [e]);
    }
    return m;
  }, [overlayRows]);

  // The 9 provider-shared base subscriptions. `nodes` is unfiltered (tombstones
  // included for Dashboard); the rest match the v1.0 per-hook active filters.
  const nodesQ = useQuery<Row>('SELECT * FROM nodes');
  const edgesQ = useQuery<Row>('SELECT * FROM edges WHERE deleted_at IS NULL');
  const entriesQ = useQuery<Row>('SELECT * FROM time_entries WHERE deleted_at IS NULL');
  const blocksQ = useQuery<Row>('SELECT * FROM schedule_blocks WHERE deleted_at IS NULL');
  const sprintsQ = useQuery<Row>('SELECT * FROM sprints WHERE deleted_at IS NULL');
  const membershipsQ = useQuery<Row>('SELECT * FROM sprint_memberships WHERE deleted_at IS NULL');
  const blockersQ = useQuery<Row>('SELECT * FROM blocker_rules WHERE deleted_at IS NULL');
  const factsQ = useQuery<Row>('SELECT * FROM external_facts WHERE deleted_at IS NULL');
  const settingsQ = useQuery<Row>('SELECT * FROM user_settings LIMIT 1');

  // Merge each table's replica rows with its overlay slice (the §7.2 two-layer
  // read), in ONE memo so the whole shared row-set is a single stable object that
  // only changes when a replica table or the overlay does.
  const rows = useMemo<SharedRows>(() => {
    const mergeFor = (replica: Row[], table: string): Row[] => {
      const eff = overlayByTable.get(table);
      return eff && eff.length ? (mergeTable(replica, eff) as Row[]) : replica;
    };
    return {
      nodes: mergeFor(nodesQ.data ?? [], 'nodes'),
      edges: mergeFor(edgesQ.data ?? [], 'edges'),
      time_entries: mergeFor(entriesQ.data ?? [], 'time_entries'),
      schedule_blocks: mergeFor(blocksQ.data ?? [], 'schedule_blocks'),
      sprints: mergeFor(sprintsQ.data ?? [], 'sprints'),
      sprint_memberships: mergeFor(membershipsQ.data ?? [], 'sprint_memberships'),
      blocker_rules: mergeFor(blockersQ.data ?? [], 'blocker_rules'),
      external_facts: mergeFor(factsQ.data ?? [], 'external_facts'),
      user_settings: mergeFor(settingsQ.data ?? [], 'user_settings'),
    };
  }, [nodesQ.data, edgesQ.data, entriesQ.data, blocksQ.data, sprintsQ.data, membershipsQ.data, blockersQ.data, factsQ.data, settingsQ.data, overlayByTable]);

  // The single fact/tree derivation — seeded ONCE, then incrementally maintained
  // (S8-F1). The engine persists across renders in a ref; the memo recomputes
  // only when the merged `rows` change (not on the screen-local `now` tick), and
  // returns a fresh FactContext identity over the live, incrementally-patched maps.
  const engineRef = useRef<Engine>({ index: null, tables: new Map(), settingsRaw: undefined });
  const factContext = useMemo(() => maintain(engineRef.current, rows), [rows]);

  const isFetching =
    overlayQ.isFetching ||
    nodesQ.isFetching ||
    edgesQ.isFetching ||
    entriesQ.isFetching ||
    blocksQ.isFetching ||
    sprintsQ.isFetching ||
    membershipsQ.isFetching ||
    blockersQ.isFetching ||
    factsQ.isFetching ||
    settingsQ.isFetching;

  // §7.14 isHydrated: a base result has been produced AND (first sync done OR a
  // row already exists locally). The `hasSynced` conjunct avoids the empty-before-
  // first-sync flash; the row-exists disjunct avoids a stuck skeleton on an
  // offline populated reload.
  const firstResult = !nodesQ.isLoading;
  const anyRow =
    rows.nodes.length > 0 ||
    rows.edges.length > 0 ||
    rows.time_entries.length > 0 ||
    rows.schedule_blocks.length > 0 ||
    rows.user_settings.length > 0 ||
    rows.sprints.length > 0 ||
    rows.blocker_rules.length > 0;
  const isHydrated = firstResult && (status.hasSynced === true || anyRow);

  const value = useMemo<PrismsData>(
    () => ({ factContext, tree: factContext.tree, rows, isFetching, isHydrated }),
    [factContext, rows, isFetching, isHydrated],
  );

  return <PrismsDataContext.Provider value={value}>{children}</PrismsDataContext.Provider>;
}

/** Read the warm session-scoped shared data (must be under `PrismsDataProvider`). */
export function usePrismsData(): PrismsData {
  const value = useContext(PrismsDataContext);
  if (value === null) throw new Error('usePrismsData must be used within a PrismsDataProvider');
  return value;
}
