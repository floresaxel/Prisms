/**
 * Kanban by date (§1.2): non-done tasks in a backlog (no due date) plus day
 * columns. Dragging a card to another column re-dates it via node.set_dates
 * (an optimistic local write that persists + syncs). Pointer-based drag so it
 * drives reliably in tests and matches the agenda's interaction.
 */
import { useEffect, useState } from 'react';

import { asEpochMillis, type Instant } from '@prisms/core';
import { useCommands, useKanban, type CommandContext } from '@prisms/ui';

export function Kanban({ ctx }: { ctx: CommandContext }) {
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 60_000);
    return () => clearInterval(t);
  }, []);

  const columns = useKanban(now);
  const commands = useCommands(ctx);

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
      <h1>Kanban</h1>
      <p className="px-muted">Drag a task between days to re-date it.</p>
      <div className="px-kanban" style={dragId ? { userSelect: 'none' } : undefined}>
        {columns.map((col) => (
          <div
            key={col.key}
            className={`px-kanban-col${dragId ? ' px-kanban-col--target' : ''}`}
            data-testid={`kanban-col-${col.key}`}
            onMouseUp={() => void dropOn(col.date)}
          >
            <div className="px-kanban-col-head">{col.label} <span className="px-muted">({col.cards.length})</span></div>
            {col.cards.map((card) => (
              <div
                key={card.id}
                className="px-kanban-card"
                data-testid={`kanban-card-${card.id}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setDragId(card.id);
                }}
              >
                {card.title}
                {card.estimate_minutes != null && <span className="px-muted"> · {card.estimate_minutes}m</span>}
              </div>
            ))}
            {col.cards.length === 0 && <div className="px-kanban-empty">—</div>}
          </div>
        ))}
      </div>
    </section>
  );
}
