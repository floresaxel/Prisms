/**
 * Gantt (§12.2): one bar per descendant task (committed-block span, else a
 * due-date day), dependency arrows from `edges`, and the critical path (longest
 * path over estimates, computed in core) highlighted. A custom SVG — cheap,
 * fully reactive, no extra deps.
 */
import { useEffect, useMemo, useState } from 'react';

import { asEpochMillis, type Instant } from '@prisms/core';
import { Skeleton, useGantt, useIsHydrated, useNodeTree } from '@prisms/ui';

const LABEL_W = 180;
const DAY_W = 22;
const ROW_H = 30;

export function Gantt() {
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 60_000);
    return () => clearInterval(t);
  }, []);

  const tree = useNodeTree();
  const projects = useMemo(
    () => [...tree.byId.values()].filter((n) => n.node_type === 'project').sort((a, b) => (a.title < b.title ? -1 : 1)),
    [tree],
  );
  const [projectId, setProjectId] = useState('');
  const active = projectId || projects[0]?.id || '';
  const gantt = useGantt(active || null, now);
  const hydrated = useIsHydrated();

  const rowOf = useMemo(() => new Map(gantt.bars.map((b, i) => [b.taskId, i])), [gantt.bars]);
  const barOf = useMemo(() => new Map(gantt.bars.map((b) => [b.taskId, b])), [gantt.bars]);

  const width = LABEL_W + Math.max(1, gantt.days) * DAY_W + 20;
  const height = Math.max(60, gantt.bars.length * ROW_H + 30);
  const rowY = (i: number) => 24 + i * ROW_H;

  return (
    <section>
      <h1>Gantt</h1>
      <select className="px-select" data-testid="gantt-project" value={active} onChange={(e) => setProjectId(e.target.value)} style={{ marginBottom: 12 }}>
        {projects.length === 0 && <option value="">{hydrated ? 'No projects yet' : 'Loading…'}</option>}
        {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
      </select>

      {gantt.bars.length === 0 ? (
        hydrated ? (
          <p className="px-muted">No dated tasks — schedule a block or set a due date to see bars.</p>
        ) : (
          <Skeleton testId="gantt-skeleton" />
        )
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <svg className="px-gantt" data-testid="gantt" width={width} height={height} role="img" aria-label="gantt chart">
            <defs>
              <marker id="px-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" className="px-gantt-arrowhead" />
              </marker>
            </defs>

            {/* day gridlines + axis */}
            {gantt.fromDate &&
              Array.from({ length: gantt.days + 1 }, (_, d) => (
                <line key={d} x1={LABEL_W + d * DAY_W} y1={18} x2={LABEL_W + d * DAY_W} y2={height} className="px-gantt-grid" />
              ))}

            {/* bars + labels */}
            {gantt.bars.map((b, i) => (
              <g key={b.taskId} data-testid={`gantt-row-${b.taskId}`}>
                <text x={4} y={rowY(i) + ROW_H / 2} className="px-gantt-label">{b.title.slice(0, 24)}</text>
                <rect
                  x={LABEL_W + b.startDay * DAY_W}
                  y={rowY(i) + 5}
                  width={Math.max(DAY_W, (b.endDay - b.startDay) * DAY_W)}
                  height={ROW_H - 12}
                  rx={4}
                  className={`px-gantt-bar${b.onCriticalPath ? ' px-gantt-bar--critical' : ''}`}
                  data-testid={`gantt-bar-${b.taskId}`}
                  data-critical={b.onCriticalPath ? 'true' : 'false'}
                />
              </g>
            ))}

            {/* dependency arrows */}
            {gantt.edges.map((e) => {
              const from = barOf.get(e.predecessorId);
              const to = barOf.get(e.successorId);
              const fi = rowOf.get(e.predecessorId);
              const ti = rowOf.get(e.successorId);
              if (from === undefined || to === undefined || fi === undefined || ti === undefined) return null;
              const x1 = LABEL_W + from.endDay * DAY_W;
              const y1 = rowY(fi) + ROW_H / 2;
              const x2 = LABEL_W + to.startDay * DAY_W;
              const y2 = rowY(ti) + ROW_H / 2;
              const midX = Math.max(x1, x2) + 10;
              return (
                <path
                  key={`${e.predecessorId}-${e.successorId}`}
                  d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                  className="px-gantt-arrow"
                  markerEnd="url(#px-arrow)"
                  fill="none"
                  data-testid={`gantt-arrow-${e.predecessorId}-${e.successorId}`}
                />
              );
            })}
          </svg>
        </div>
      )}

      {gantt.criticalPathIds.length > 0 && (
        <p className="px-muted" data-testid="gantt-critical">Critical path: {gantt.criticalPathIds.length} task(s)</p>
      )}
      {gantt.fromDate && <p className="px-muted">from {gantt.fromDate}, {gantt.days}-day window</p>}
    </section>
  );
}
