/**
 * S19: decision-board priority = Σ weight×score / Σ weight (§6.0), computed in
 * core so weight/score edits reorder instantly.
 */
import { describe, expect, it } from 'vitest';

import { rankProjects } from '../../src/aggregates/decision';

const C1 = 'criterion-1';
const C2 = 'criterion-2';
const PA = 'project-a';
const PB = 'project-b';

describe('rankProjects', () => {
  it('weights the scores and normalizes by total weight', () => {
    const criteria = [{ id: C1, weight: 1 }, { id: C2, weight: 3 }];
    const scores = [
      { criterion_id: C1, project_id: PA, score: 10 },
      { criterion_id: C2, project_id: PA, score: 2 },
      { criterion_id: C1, project_id: PB, score: 4 },
      { criterion_id: C2, project_id: PB, score: 8 },
    ];
    const ranked = rankProjects(criteria, scores, [PA, PB]);
    // A: (1×10 + 3×2)/4 = 4.0 ; B: (1×4 + 3×8)/4 = 7.0 → B first
    expect(ranked.map((r) => r.projectId)).toEqual([PB, PA]);
    expect(ranked[0]!.priority).toBeCloseTo(7);
    expect(ranked[1]!.priority).toBeCloseTo(4);
  });

  it('reorders when a weight changes (the DoD behavior)', () => {
    const scores = [
      { criterion_id: C1, project_id: PA, score: 10 }, // A great on C1
      { criterion_id: C2, project_id: PA, score: 0 },
      { criterion_id: C1, project_id: PB, score: 0 },
      { criterion_id: C2, project_id: PB, score: 10 }, // B great on C2
    ];
    const c1Heavy = rankProjects([{ id: C1, weight: 5 }, { id: C2, weight: 1 }], scores, [PA, PB]);
    expect(c1Heavy.map((r) => r.projectId)).toEqual([PA, PB]);
    const c2Heavy = rankProjects([{ id: C1, weight: 1 }, { id: C2, weight: 5 }], scores, [PA, PB]);
    expect(c2Heavy.map((r) => r.projectId)).toEqual([PB, PA]);
  });

  it('missing scores count as 0; no criteria → all zero, id-stable order', () => {
    const ranked = rankProjects([{ id: C1, weight: 2 }], [{ criterion_id: C1, project_id: PB, score: 6 }], [PA, PB]);
    expect(ranked.map((r) => r.projectId)).toEqual([PB, PA]);
    expect(ranked.find((r) => r.projectId === PA)!.priority).toBe(0);

    const none = rankProjects([], [], [PB, PA]);
    expect(none.every((r) => r.priority === 0)).toBe(true);
    expect(none.map((r) => r.projectId)).toEqual([PA, PB]); // id tiebreak
  });
});
