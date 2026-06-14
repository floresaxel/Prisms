/**
 * Decision-board priority (§6.0): `priority(project) = Σ weight×score / Σ weight`
 * over the board's criteria. Computed in core, never stored — the dashboard
 * priority list and the board's live ranking both call this, so a weight or
 * score edit reorders instantly and offline.
 *
 * Missing scores contribute 0 to the numerator; the denominator is the board's
 * total criterion weight (constant across projects), so priorities are
 * comparable on a 0–10 scale. Ties break by project id for determinism.
 */
import type { Uuid } from '../domain/primitives';

export interface ProjectPriority {
  projectId: Uuid;
  priority: number;
}

export function rankProjects(
  criteria: readonly { id: Uuid; weight: number }[],
  scores: readonly { criterion_id: Uuid; project_id: Uuid; score: number }[],
  projectIds: readonly Uuid[],
): ProjectPriority[] {
  let totalWeight = 0;
  const weightByCriterion = new Map<Uuid, number>();
  for (const c of criteria) {
    weightByCriterion.set(c.id, c.weight);
    totalWeight += c.weight;
  }

  const numeratorByProject = new Map<Uuid, number>();
  for (const s of scores) {
    const weight = weightByCriterion.get(s.criterion_id);
    if (weight === undefined) continue; // score for a deleted/foreign criterion
    numeratorByProject.set(s.project_id, (numeratorByProject.get(s.project_id) ?? 0) + weight * s.score);
  }

  return projectIds
    .map((projectId) => ({
      projectId,
      priority: totalWeight > 0 ? (numeratorByProject.get(projectId) ?? 0) / totalWeight : 0,
    }))
    .sort((a, b) => b.priority - a.priority || (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0));
}
