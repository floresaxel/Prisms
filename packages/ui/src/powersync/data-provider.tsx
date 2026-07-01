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
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { useQuery, useStatus } from '@powersync/react';
import { buildFactContext, mergeTable, type FactContext, type OverlayEffect, type TreeIndex } from '@prisms/core';

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

  // The single fact/tree derivation — built once, memoized on the shared rows.
  // Nodes are filtered to the active set here (the tree/status world), while
  // `rows.nodes` keeps tombstones for Dashboard.
  const factContext = useMemo(
    () =>
      buildFactContext({
        nodes: rows.nodes.filter((r) => r['deleted_at'] == null).map(toNode),
        edges: rows.edges.map(toEdge),
        time_entries: rows.time_entries.map(toTimeEntry),
        schedule_blocks: rows.schedule_blocks.map(toScheduleBlock),
        sprints: rows.sprints.map(toSprint),
        sprint_memberships: rows.sprint_memberships.map(toMembership),
        blocker_rules: rows.blocker_rules.map(toBlockerRule),
        external_facts: rows.external_facts.map(toExternalFact),
        user_settings: rows.user_settings[0] ? toUserSettings(rows.user_settings[0]) : null,
      }),
    [rows],
  );

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
