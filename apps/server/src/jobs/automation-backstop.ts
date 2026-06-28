/**
 * automation.backstop (§9.4, §11): enqueued by the dispatcher on every
 * task_created / task_completed. Re-runs the SAME rules engine the client
 * ran, so a stale or offline device's missed automations get filled — and an
 * already-spawned output is a structural no-op, because the spawned ids are
 * deterministic UUIDv5 and the inserts are ON CONFLICT DO NOTHING.
 */
import {
  runAutomations,
  type AutomationRule,
  type Edge,
  type Node as CoreNode,
} from '@prisms/core';
import { automation_rules, edges, nodes } from '@prisms/db';
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
  /** True when nothing new was written — the device already spawned everything (or no rule fired). */
  noop: boolean;
}

export async function runAutomationBackstop(db: PostgresJsDatabase, job: BackstopJob): Promise<BackstopResult> {
  return db.transaction(async (tx) => {
    const trigger = (await tx.select().from(nodes).where(and(eq(nodes.id, job.nodeId), eq(nodes.user_id, job.userId))).limit(1))[0] as
      | CoreNode
      | undefined;
    if (!trigger || trigger.deleted_at !== null) return { nodesInserted: 0, edgesInserted: 0, noop: true };

    const [nodeRows, edgeRows, ruleRows] = await Promise.all([
      tx.select().from(nodes).where(eq(nodes.user_id, job.userId)),
      tx.select().from(edges).where(and(eq(edges.user_id, job.userId), isNull(edges.deleted_at))),
      tx.select().from(automation_rules).where(and(eq(automation_rules.user_id, job.userId), isNull(automation_rules.deleted_at))),
    ]);

    const out = runAutomations({
      trigger: { kind: job.trigger, node: trigger },
      rules: ruleRows as AutomationRule[],
      rows: { nodes: nodeRows as CoreNode[], edges: edgeRows as Edge[] },
    });

    // backstop-filled rows are server automation output (§7.8); the in-txn path
    // (dispatcher §10.1) is authoritative, so this only fills offline/drift gaps.
    const prov = <T extends object>(row: T): T => ({ ...row, source_kind: 'automation', source_detail: { trigger_node_id: job.nodeId, backstop: true } });
    let nodesInserted = 0;
    for (const node of out.nodes) {
      const res = await tx.insert(nodes).values(prov(node) as typeof nodes.$inferInsert).onConflictDoNothing({ target: nodes.id });
      nodesInserted += res.count ?? 0;
    }
    let edgesInserted = 0;
    for (const edge of out.edges) {
      const res = await tx.insert(edges).values(prov(edge) as typeof edges.$inferInsert).onConflictDoNothing({ target: edges.id });
      edgesInserted += res.count ?? 0;
    }

    return { nodesInserted, edgesInserted, noop: nodesInserted === 0 && edgesInserted === 0 };
  });
}
