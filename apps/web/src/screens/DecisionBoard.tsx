/**
 * Decision board (§1.2, §6.0): a weighted matrix for prioritizing projects.
 * Criteria are columns with editable weights; projects are rows; each cell is
 * a 0–10 score. The live ranking (priority = Σ weight×score / Σ weight, from
 * core) reorders instantly as weights or scores change — all offline.
 */
import { useState } from 'react';

import { Skeleton, useCommands, useDecisionBoards, useDecisionsHydrated, type CommandContext, type DecisionBoardView } from '@prisms/ui';

function BoardGrid({ view, ctx }: { view: DecisionBoardView; ctx: CommandContext }) {
  const commands = useCommands(ctx);
  const [label, setLabel] = useState('');
  const [weight, setWeight] = useState('1');

  async function addCriterion(e: React.FormEvent) {
    e.preventDefault();
    const w = Number(weight);
    if (label.trim() === '' || !(w > 0)) return;
    await commands.createCriterion({ boardId: view.board.id, label: label.trim(), weight: w });
    setLabel('');
    setWeight('1');
  }

  return (
    <div className="px-board" data-testid={`board-${view.board.id}`}>
      <h2>{view.board.title}</h2>

      <form onSubmit={addCriterion} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input className="px-input" placeholder="New criterion…" value={label} data-testid="criterion-label" onChange={(e) => setLabel(e.target.value)} />
        <input className="px-input" placeholder="weight" value={weight} data-testid="criterion-weight" onChange={(e) => setWeight(e.target.value.replace(/[^0-9.]/g, ''))} style={{ width: 90 }} />
        <button className="px-btn px-btn--primary" type="submit" data-testid="add-criterion">Add criterion</button>
      </form>

      {view.criteria.length === 0 ? (
        <p className="px-muted">Add a criterion to start scoring.</p>
      ) : view.projects.length === 0 ? (
        <p className="px-muted">No projects to score yet.</p>
      ) : (
        <table className="px-grid">
          <thead>
            <tr>
              <th>Project</th>
              {view.criteria.map((c) => (
                <th key={c.id}>
                  <div>{c.label}</div>
                  <input
                    className="px-input px-grid-weight"
                    type="number" min="0.1" step="0.1"
                    value={c.weight}
                    data-testid={`weight-${c.id}`}
                    onChange={(e) => { const w = Number(e.target.value); if (w > 0) void commands.setCriterionWeight(c.id, w); }}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.projects.map((project) => (
              <tr key={project.id}>
                <td>{project.title}</td>
                {view.criteria.map((c) => {
                  const cell = view.scores.get(`${c.id}:${project.id}`);
                  return (
                    <td key={c.id}>
                      <input
                        className="px-input px-grid-score"
                        type="number" min="0" max="10" step="1"
                        value={cell?.score ?? ''}
                        data-testid={`score-${c.id}-${project.id}`}
                        onChange={(e) => {
                          if (e.target.value === '') return;
                          const score = Math.max(0, Math.min(10, Number(e.target.value)));
                          void commands.setScore({ existingId: cell?.id, criterionId: c.id, projectId: project.id, score });
                        }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Ranking</h3>
      <ol className="px-ranking" data-testid={`ranking-${view.board.id}`}>
        {view.ranking.map((r) => (
          <li key={r.project.id} data-testid={`rank-${r.project.id}`}>
            {r.project.title} <span className="px-muted">{r.priority.toFixed(2)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function DecisionBoard({ ctx }: { ctx: CommandContext }) {
  const boards = useDecisionBoards();
  const commands = useCommands(ctx);
  const hydrated = useDecisionsHydrated();

  return (
    <section>
      <h1>Decision board</h1>
      <button className="px-btn" data-testid="new-board" onClick={() => void commands.createBoard('Priorities')} style={{ marginBottom: 16 }}>
        New board
      </button>
      {boards.length === 0 &&
        (hydrated ? (
          <p className="px-muted">No boards yet — create one to weigh projects against criteria.</p>
        ) : (
          <Skeleton testId="decisions-skeleton" />
        ))}
      {boards.map((view) => <BoardGrid key={view.board.id} view={view} ctx={ctx} />)}
    </section>
  );
}
