/**
 * Dashboard (§1.2): burndown + projection vs. the scheduled line, project
 * completion bars, the priority items list (decision-board ranking), and a
 * streak summary. Every panel is a core selector over local facts, so the
 * whole view renders offline; the projection carries a freshness label from
 * the server aggregate's computed_at (live client estimate until then).
 */
import { useEffect, useMemo, useState } from 'react';

import { asEpochMillis, type BurndownValue, type Instant } from '@prisms/core';
import { Ic, useCommands, useDashboard, useDecisionBoards, useDecisionsHydrated, useHabits, useHabitsHydrated, useIsHydrated, useNodeTree, type CommandContext } from '@prisms/ui';

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
  // §7.15: each panel gates its own empty branch — completion on the shared base
  // tables, priority on the decision-board read, streaks on the habits read.
  const sessionHydrated = useIsHydrated();
  const boardsHydrated = useDecisionsHydrated();
  const habitsHydrated = useHabitsHydrated();

  const proj = data.burndown.projection;
  const visions = useMemo(() => [...tree.byId.values()].filter((n) => n.node_type === 'vision'), [tree]);

  return (
    <section data-testid="dashboard">
      <div className="px-page-head">
        <h1>Dashboard</h1>
        {/* Vision angles (max 4, I2). New-vision doubles as the optimistic-rollback demo. */}
        <span className="px-page-sub" data-testid="visions">
          Vision angles <span data-testid="vision-count">({visions.length})</span>: {visions.map((v) => v.title).join(', ') || 'none yet'}
        </span>
        <div className="px-head-actions">
          <button className="px-btn px-btn--sm" data-testid="new-vision" onClick={() => void commands.createVision('New Angle')}>New vision</button>
        </div>
      </div>

      <div className="px-dash">
        <div className="px-card">
          <div className="px-card-title">Burndown &amp; projection</div>
          <div className="px-dash-pad">
            <Burndown value={data.burndown} />
            <div className="px-muted" data-testid="projection" style={{ marginTop: 10 }}>
              Projected finish: <strong>{proj.projectedFinishDate ?? '—'}</strong>
              {' · '}{Math.round(proj.dailyVelocityMinutes)} min/day burn{' · '}
              <span data-testid="projection-freshness">
                {data.projectionComputedAt ? `updated ${new Date(data.projectionComputedAt).toLocaleDateString()}` : 'live (client estimate)'}
              </span>
            </div>
          </div>
        </div>

        <div className="px-card">
          <div className="px-card-title">Priority items</div>
          <ul className="px-plist" data-testid="priority-list">
            {priority.length === 0 && <li className="px-pli px-muted">{boardsHydrated ? 'No decision board yet.' : 'Loading…'}</li>}
            {priority.map((r, i) => (
              <li className="px-pli" key={r.project.id}>
                <span className={`px-pli-rank${i === 0 ? ' px-pli-rank--1' : ''}`}>{i + 1}</span>
                <span data-testid={`priority-${r.project.id}`}>{r.project.title}</span>
                <span className="px-pli-prio">{r.priority.toFixed(1)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="px-card">
          <div className="px-card-title">Project completion</div>
          <div className="px-dash-pad" data-testid="completion">
            {data.completion.length === 0 && <div className="px-muted">{sessionHydrated ? 'No projects yet.' : 'Loading…'}</div>}
            {data.completion.map(({ project, value }) => (
              <div className="px-cbar" key={project.id}>
                <div className="px-cbar-lbl"><span>{project.title}</span><span>{Math.round(value.percent)}%</span></div>
                <div className="px-cbar-trk"><div className="px-cbar-fil" style={{ width: `${value.percent}%` }} /></div>
              </div>
            ))}
          </div>
        </div>

        <div className="px-card">
          <div className="px-card-title">Streaks</div>
          <ul className="px-plist" data-testid="streak-summary">
            {habits.length === 0 && <li className="px-pli px-muted">{habitsHydrated ? 'No habits yet.' : 'Loading…'}</li>}
            {habits.map((h) => {
              const tc = h.tagConfirmation;
              const total = tc.yes + tc.no + tc.pending;
              return (
                <li className="px-pli" key={h.habit.id}>
                  <span className="px-streak" style={{ marginLeft: 0 }}><Ic name="flame" />{h.streak.current}</span>
                  <span>{h.habit.title}</span>
                  {total > 0 && (
                    <span className="px-muted" data-testid={`tagconf-${h.habit.id}`}>✓ {tc.yes}/{total}{tc.pending > 0 ? ` (${tc.pending} pending)` : ''}</span>
                  )}
                  <span className="px-pli-prio">best {h.streak.longest}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
