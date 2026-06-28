/**
 * automation.backstop (§9.4, §10.2, §11): enqueued by the dispatcher on every
 * task_created / task_completed. The in-txn automation (dispatcher §10.1) is
 * authoritative; this is the drift / offline-gap safety-net. It re-runs the SAME
 * rules engine and, per deterministic UUIDv5 id:
 *   - absent  → insert it (fills a gap a stale/offline device missed);
 *   - present + content-equivalent → no-op;
 *   - present + content differs (rule/template version skew, §10.2) → KEEP the
 *     existing row, do not overwrite, and raise an `automation_drift` item.
 * Filling missed rows raises one informational `automation_backstop` item.
 * Spawns are validated (I1/I3) like the in-txn path so a bad rule cannot commit
 * an invariant-violating row here either.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  buildTreeIndex,
  checkNodeCreate,
  runAutomations,
  spawnedNodeContent,
  type AutomationRule,
  type Edge,
  type Node as CoreNode,
} from '@prisms/core';
import { automation_rules, edges, nodes, sync_review_items } from '@prisms/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export interface BackstopJob {
  userId: string;
  trigger: 'task_created' | 'task_completed';
  nodeId: string;
}

export interface BackstopResult {
  /** Spawned rows that did not already exist (filled a gap). */
  nodesInserted: number;
  edgesInserted: number;
  /** Deterministic ids found present with divergent content (§10.2). */
  driftItems: number;
  /** sync_review_items rows created this run (automation_backstop + automation_drift). */
  reviewItemIds: string[];
  /** True when nothing was written — no fills and no drift (the device already converged). */
  noop: boolean;
}

/** Compact content fingerprint for the §10.2 drift review item. */
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export async function runAutomationBackstop(db: PostgresJsDatabase, job: BackstopJob): Promise<BackstopResult> {
  return db.transaction(async (tx) => {
    const empty: BackstopResult = { nodesInserted: 0, edgesInserted: 0, driftItems: 0, reviewItemIds: [], noop: true };
    const trigger = (await tx.select().from(nodes).where(and(eq(nodes.id, job.nodeId), eq(nodes.user_id, job.userId))).limit(1))[0] as
      | CoreNode
      | undefined;
    if (!trigger || trigger.deleted_at !== null) return empty;

    // All rows (incl. soft-deleted) so a deleted spawn isn't resurrected; live
    // edges feed the engine's edge index.
    const [allNodeRows, allEdgeRows, ruleRows] = await Promise.all([
      tx.select().from(nodes).where(eq(nodes.user_id, job.userId)),
      tx.select().from(edges).where(eq(edges.user_id, job.userId)),
      tx.select().from(automation_rules).where(and(eq(automation_rules.user_id, job.userId), isNull(automation_rules.deleted_at))),
    ]);
    const liveEdges = (allEdgeRows as Edge[]).filter((e) => e.deleted_at === null);

    const out = runAutomations({
      trigger: { kind: job.trigger, node: trigger },
      rules: ruleRows as AutomationRule[],
      rows: { nodes: allNodeRows as CoreNode[], edges: liveEdges },
    });

    // §6.7: drop spawns that would violate I1/I3, and edges dangling off them.
    const tree = buildTreeIndex([...(allNodeRows as CoreNode[]), ...out.nodes]);
    const liveNodeIds = new Set((allNodeRows as CoreNode[]).filter((n) => n.deleted_at === null).map((n) => n.id));
    const keptNodeIds = new Set<string>();
    const keepNodes = out.nodes.filter((n) => {
      if (!checkNodeCreate(tree, n).ok) return false;
      keptNodeIds.add(n.id);
      return true;
    });
    const endpointOk = (id: string) => liveNodeIds.has(id) || keptNodeIds.has(id);
    const keepEdges = out.edges.filter((e) => endpointOk(e.predecessor_id) && endpointOk(e.successor_id));

    const provById = new Map(out.provenance.map((p) => [p.id, p]));
    const ruleVersionOf = (rowId: string) => {
      const ruleId = provById.get(rowId)?.rule_id;
      return (ruleRows as AutomationRule[]).find((r) => r.id === ruleId)?.rule_version ?? null;
    };
    const prov = <T extends { id: string }>(row: T) => {
      const p = provById.get(row.id);
      return {
        ...row,
        source_kind: 'automation' as const,
        source_id: p?.rule_id ?? null,
        source_detail: { trigger_node_id: job.nodeId, action_slot: p?.slot ?? null, backstop: true },
      };
    };

    const nodeById = new Map((allNodeRows as CoreNode[]).map((n) => [n.id, n]));
    const filled: string[] = [];
    const drift: Array<{ id: string; kind: 'node' | 'edge'; existingHash: string; spawnedHash: string; ruleVersion: number | null }> = [];

    // Fill: spawned rows the engine found ABSENT from the live fact set. A
    // soft-deleted row at the same id is respected (onConflictDoNothing keeps it).
    let nodesInserted = 0;
    for (const node of keepNodes) {
      const res = await tx.insert(nodes).values(prov(node) as typeof nodes.$inferInsert).onConflictDoNothing();
      if ((res.count ?? 0) > 0) {
        nodesInserted += 1;
        filled.push(node.id);
      }
    }
    let edgesInserted = 0;
    for (const edge of keepEdges) {
      const res = await tx.insert(edges).values(prov(edge) as typeof edges.$inferInsert).onConflictDoNothing();
      if ((res.count ?? 0) > 0) {
        edgesInserted += 1;
        filled.push(edge.id);
      }
    }

    // §10.2 drift: the deterministic id is PRESENT in the live fact set (a replay).
    // Compare the would-be content against the existing row; keep the existing row,
    // do not overwrite, and record divergence.
    for (const node of out.replayedNodes) {
      const existing = nodeById.get(node.id);
      if (!existing || existing.deleted_at !== null) continue;
      const a = spawnedNodeContent(existing);
      const b = spawnedNodeContent(node);
      if (a !== b) drift.push({ id: node.id, kind: 'node', existingHash: hash(a), spawnedHash: hash(b), ruleVersion: ruleVersionOf(node.id) });
    }

    // §7.13 review items (informational, server_job-owned).
    const reviewItemIds: string[] = [];
    const at = new Date().toISOString();
    const addItem = async (item_type: 'automation_backstop' | 'automation_drift', title: string, detail: typeof sync_review_items.$inferInsert.detail) => {
      const id = randomUUID();
      await tx.insert(sync_review_items).values({
        id,
        user_id: job.userId,
        command_id: null,
        item_type,
        severity: 'info',
        title,
        detail,
        status: 'open',
        source_kind: 'server_job',
        created_at: at,
        updated_at: at,
      });
      reviewItemIds.push(id);
    };
    if (filled.length > 0) {
      await addItem('automation_backstop', `Automation backstop filled ${filled.length} missed row(s)`, { trigger_node_id: job.nodeId, filled_ids: filled });
    }
    for (const d of drift) {
      await addItem('automation_drift', `Automation drift on ${d.kind} ${d.id}`, {
        id: d.id,
        kind: d.kind,
        rule_version: d.ruleVersion,
        existing_content_hash: d.existingHash,
        spawned_content_hash: d.spawnedHash,
      });
    }

    return { nodesInserted, edgesInserted, driftItems: drift.length, reviewItemIds, noop: nodesInserted === 0 && edgesInserted === 0 && drift.length === 0 };
  });
}
