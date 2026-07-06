/**
 * Kanban by date (§1.2): non-done tasks in a backlog (no due date) plus day
 * columns. Dragging a card to another column re-dates it via node.set_dates
 * (an optimistic local write that persists + syncs). Pointer-based drag so it
 * drives reliably in tests and matches the agenda's interaction. `projectId`
 * comes from the Projects hub scope picker (W5); null = all projects.
 */
import { useEffect, useMemo, useState } from 'react';

import { ancestorsOf, asEpochMillis, type Instant } from '@prisms/core';
import { Skeleton, useCommands, useIsHydrated, useKanban, useNodeTree, type CommandContext } from '@prisms/ui';

import { projectTone } from '../format';

export function Kanban({ ctx, projectId }: { ctx: CommandContext; projectId?: string | null }) {
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 60_000);
    return () => clearInterval(t);
  }, []);

  const columns = useKanban(now, projectId ?? null);
  const tree = useNodeTree();
  const commands = useCommands(ctx);
  const hydrated = useIsHydrated();

  // per-card parent project (dot + name) — useful when the scope is "All projects".
  const projectOf = useMemo(() => {
    const m = new Map<string, { id: string; title: string } | null>();
    for (const col of columns) {
      for (const c of col.cards) {
        const p = ancestorsOf(tree, c.id).find((a) => a.node_type === 'project');
        m.set(c.id, p ? { id: p.id, title: p.title } : null);
      }
    }
    return m;
  }, [columns, tree]);

  const [dragId, setDragId] = useState<string | null>(null);
  useEffect(() => {
    const onUp = () => setDragId(null);
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, []);

  async function dropOn(date: string | null) {
    if (dragId === null) return;
    const id = dragId;
    setDragId(null);
    await commands.setDates(id, { dueDate: date });
  }

  return (
    <section>
      {!hydrated && <Skeleton testId="kanban-skeleton" rows={4} />}
      <div className="px-kanban" style={dragId ? { userSelect: 'none' } : undefined} hidden={!hydrated}>
        {columns.map((col) => {
          const isToday = col.label.startsWith('Today');
          return (
            <div
              key={col.key}
              className={`px-kanban-col${isToday ? ' px-kanban-col--today' : ''}${dragId ? ' px-kanban-col--target' : ''}`}
              data-testid={`kanban-col-${col.key}`}
              onMouseUp={() => void dropOn(col.date)}
            >
              <div className="px-kanban-col-head">{col.label} <span className="px-kanban-col-count">{col.cards.length}</span></div>
              {col.cards.map((card) => {
                const proj = projectOf.get(card.id);
                return (
                  <div
                    key={card.id}
                    className="px-kanban-card"
                    data-testid={`kanban-card-${card.id}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setDragId(card.id);
                    }}
                  >
                    <b>{card.title}</b>
                    <div className="px-t-meta">
                      {proj && <span className="px-proj"><span className={`px-pdot px-pdot--${projectTone(proj.id)}`} />{proj.title}</span>}
                      {card.estimate_minutes != null && <span>{card.estimate_minutes}m</span>}
                    </div>
                  </div>
                );
              })}
              {col.cards.length === 0 && <div className="px-kanban-empty">—</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
