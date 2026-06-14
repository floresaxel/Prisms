/**
 * Dashboard (§1.2): burndown + projection vs. the scheduled line, project
 * completion bars, the priority items list (decision-board ranking), and a
 * streak summary. Every panel is a core selector over local facts, so the
 * whole view renders offline; the projection carries a freshness label from
 * the server aggregate's computed_at (live client estimate until then).
 */
import { useEffect, useMemo, useState } from 'react';

import { asEpochMillis, type BurndownValue, type Instant } from '@prisms/core';
import { List, ListItem, useCommands, useDashboard, useDecisionBoards, useHabits, useNodeTree, type CommandContext } from '@prisms/ui';

function Burndown({ value }: { value: BurndownValue }) {
  const days = value.days;
  const W = 640, H = 160, padL = 10, padR = 10, padT = 12, padB = 20;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const maxV = Math.max(1, ...days.map((d) => Math.max(d.remainingMinutes, d.scheduledMinutes)));
  const x = (i: number) => padL + (days.length <= 1 ? 0 : (i / (days.length - 1)) * innerW);
  const y = (v: number) => padT + innerH - (v / maxV) * innerH;
  const barW = Math.max(2, (innerW / Math.max(1, days.length)) * 0.5);
  const remaining = days.map((d, i) => `${x(i)},${y(d.remainingMinutes)}`).join(' ');

  return (
    <svg className="px-chart" viewBox={`0 0 ${W} ${H}`} data-testid="burndown" role="img" aria-label="burndown chart">
      <line x1={padL} y1={padT + innerH} x2={W - padR} y2={padT + innerH} className="px-chart-axis" />
      {days.map((d, i) => d.scheduledMinutes > 0 && (
        <rect key={i} x={x(i) - barW / 2} y={y(d.scheduledMinutes)} width={barW} height={padT + innerH - y(d.scheduledMinutes)} className="px-chart-bar" />
      ))}
      {days.length > 1 && <polyline points={remaining} className="px-chart-line" fill="none" />}
      {days.map((d, i) => <circle key={i} cx={x(i)} cy={y(d.remainingMinutes)} r={2} className="px-chart-dot" />)}
    </svg>
  );
}

export function Dashboard({ ctx }: { ctx: CommandContext }) {
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 60_000);
    return () => clearInterval(t);
  }, []);

  const data = useDashboard(now);
  const boards = useDecisionBoards();
  const habits = useHabits(now);
  const tree = useNodeTree();
  const commands = useCommands(ctx);
  const priority = boards[0]?.ranking ?? [];

  const proj = data.burndown.projection;
  const visions = useMemo(() => [...tree.byId.values()].filter((n) => n.node_type === 'vision'), [tree]);

  return (
    <section data-testid="dashboard">
      <h1>Dashboard</h1>

      {/* Vision angles (max 4, I2). New-vision doubles as the optimistic-
          rollback demo until the S20 vision editor lands. */}
      <div className="px-muted" style={{ marginBottom: 16 }} data-testid="visions">
        Vision angles <span data-testid="vision-count">({visions.length})</span>: {visions.map((v) => v.title).join(', ') || 'none yet'}
        <button className="px-btn" style={{ marginLeft: 10 }} data-testid="new-vision" onClick={() => void commands.createVision('New Angle')}>
          New vision
        </button>
      </div>

      <h2>Burndown</h2>
      <Burndown value={data.burndown} />
      <div className="px-muted" data-testid="projection">
        Projected finish:{' '}
        <strong>{proj.projectedFinishDate ?? '—'}</strong>
        {' · '}{Math.round(proj.dailyVelocityMinutes)} min/day burn
        {' · '}
        <span data-testid="projection-freshness">
          {data.projectionComputedAt ? `updated ${new Date(data.projectionComputedAt).toLocaleDateString()}` : 'live (client estimate)'}
        </span>
      </div>

      <div className="px-dash-grid">
        <div>
          <h2>Project completion</h2>
          <div data-testid="completion">
            <List empty="No projects yet.">
              {data.completion.map(({ project, value }) => (
                <ListItem key={project.id} trailing={<span className="px-muted">{Math.round(value.percent)}%</span>}>
                  {project.title}
                  <div className="px-progress" style={{ marginTop: 6 }}>
                    <div className="px-progress-fill" style={{ width: `${value.percent}%` }} />
                  </div>
                </ListItem>
              ))}
            </List>
          </div>
        </div>

        <div>
          <h2>Priority items</h2>
          <div data-testid="priority-list">
            <List empty="No decision board yet — create one to rank projects.">
              {priority.map((r, i) => (
                <ListItem key={r.project.id} leading={<span className="px-badge">{i + 1}</span>} trailing={<span className="px-muted">{r.priority.toFixed(1)}</span>}>
                  <span data-testid={`priority-${r.project.id}`}>{r.project.title}</span>
                </ListItem>
              ))}
            </List>
          </div>

          <h2 style={{ marginTop: 24 }}>Streaks</h2>
          <div data-testid="streak-summary">
            <List empty="No habits yet.">
              {habits.map((h) => (
                <ListItem key={h.habit.id} trailing={<span className="px-muted">best {h.streak.longest}</span>}>
                  🔥 {h.streak.current} · {h.habit.title}
                </ListItem>
              ))}
            </List>
          </div>
        </div>
      </div>
    </section>
  );
}
