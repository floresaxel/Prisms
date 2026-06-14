/**
 * Agenda (§12.2, §10 client mode): a week calendar beside a to-do panel.
 * Drag a to-do task onto the week — while dragging, the valid time windows
 * (core `validWindowsFor`, greedy mode) light up and everything else dims;
 * dropping in a valid slot creates a committed block. Committed blocks drag to
 * move; anchored blocks show a lock and refuse the drag (I7). Suggested blocks
 * render dashed with accept/reject (§2.6); blocks whose ancestry reaches no
 * vision render dark grey (§12.2); past time_entries are a faint history layer.
 *
 * Drag is pointer-based (mousedown→mouseup) rather than HTML5 DnD so the live
 * window-hint state is observable mid-drag and it drives reliably in tests.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  addDays,
  asEpochMillis,
  bucketDate,
  epochMillisToIso,
  localInstant,
  validWindowsFor,
  type Instant,
  type Interval,
  type SchedulableTask,
} from '@prisms/core';
import { useAgenda, useCommands, type AgendaBlock, type CommandContext } from '@prisms/ui';

const GRID_START_HOUR = 6;
const GRID_END_HOUR = 22;
const HOUR_PX = 44;
const MS_PER_MIN = 60_000;
const BODY_HEIGHT = (GRID_END_HOUR - GRID_START_HOUR) * HOUR_PX;
const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface DragState {
  taskId: string;
  durationMs: number;
  /** Set when moving an existing block rather than placing a new one. */
  blockId?: string;
  valid: Interval[];
}

function fmtHour(h: number): string {
  const ampm = h < 12 || h === 24 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${ampm}`;
}

export function Agenda({ ctx }: { ctx: CommandContext }) {
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 60_000);
    return () => clearInterval(t);
  }, []);

  const [weekOffset, setWeekOffset] = useState(0);
  const agenda = useAgenda(now);
  const commands = useCommands(ctx);
  const tz = agenda.input.timezone;

  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  // cancel a drag that ends anywhere other than a valid cell
  useEffect(() => {
    const onUp = () => setDrag(null);
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, []);

  const days = useMemo(() => {
    const base = addDays(bucketDate(now, 0, tz), weekOffset * 7);
    return Array.from({ length: 7 }, (_, i) => addDays(base, i));
  }, [now, tz, weekOffset]);

  const colIndexOf = (start: Instant): number => days.indexOf(bucketDate(start, 0, tz));

  function place(start: Instant, end: Instant): { col: number; top: number; height: number } | null {
    const col = colIndexOf(start);
    if (col < 0) return null;
    const base = localInstant(days[col]!, GRID_START_HOUR, tz);
    const top = ((start - base) / MS_PER_MIN / 60) * HOUR_PX;
    const height = Math.max(16, ((end - start) / MS_PER_MIN / 60) * HOUR_PX);
    return { col, top, height };
  }

  function startTaskDrag(task: SchedulableTask) {
    setDrag({ taskId: task.id, durationMs: task.estimateMinutes * MS_PER_MIN, valid: validWindowsFor(task, agenda.input) });
  }

  function startBlockDrag(block: AgendaBlock) {
    if (block.anchored) return; // I7: anchored blocks refuse the drag
    const task = agenda.tasksById.get(block.taskId);
    if (!task) return;
    setDrag({ taskId: block.taskId, blockId: block.id, durationMs: task.estimateMinutes * MS_PER_MIN, valid: validWindowsFor(task, agenda.input) });
  }

  const cellValid = (cellStart: Instant, durationMs: number, valid: Interval[]): boolean =>
    valid.some((w) => w.start <= cellStart && cellStart + durationMs <= w.end);

  async function dropAt(cellStart: Instant) {
    const d = dragRef.current;
    if (!d || !cellValid(cellStart, d.durationMs, d.valid)) return;
    const startsAt = epochMillisToIso(cellStart);
    const endsAt = epochMillisToIso(asEpochMillis(cellStart + d.durationMs));
    if (d.blockId) await commands.moveBlock(d.blockId, startsAt, endsAt);
    else await commands.createBlock({ taskId: d.taskId, startsAt, endsAt });
    setDrag(null);
  }

  return (
    <section className="px-agenda" style={drag ? { userSelect: 'none' } : undefined}>
      <div className="px-agenda-todo">
        <h2>To-do</h2>
        <p className="px-muted">Drag a task onto the week to schedule it.</p>
        <div data-testid="todo-list" className="px-list">
          {agenda.todo.length === 0 && <div className="px-list-empty">Nothing to place.</div>}
          {agenda.todo.map(({ task, schedulable }) => (
            <div
              key={task.id}
              className="px-todo-item"
              data-testid={`todo-${task.id}`}
              onMouseDown={(e) => {
                e.preventDefault();
                startTaskDrag(schedulable);
              }}
            >
              <span>{task.title}</span>
              <span className="px-muted">{schedulable.estimateMinutes}m</span>
            </div>
          ))}
        </div>
      </div>

      <div className="px-agenda-cal">
        <div className="px-cal-head">
          <button className="px-btn" data-testid="week-prev" onClick={() => setWeekOffset((w) => w - 1)}>‹</button>
          <h2 style={{ margin: 0 }}>{days[0]} – {days[6]}</h2>
          <button className="px-btn" data-testid="week-next" onClick={() => setWeekOffset((w) => w + 1)}>›</button>
        </div>

        <div className="px-cal-grid">
          <div className="px-cal-gutter" style={{ height: BODY_HEIGHT }}>
            {Array.from({ length: GRID_END_HOUR - GRID_START_HOUR }, (_, i) => (
              <div key={i} className="px-cal-hour-label" style={{ top: i * HOUR_PX }}>{fmtHour(GRID_START_HOUR + i)}</div>
            ))}
          </div>

          {days.map((date, col) => (
            <div key={date} className="px-cal-col" data-testid={`day-${col}`}>
              <div className="px-cal-col-head">{DAY_LABEL[new Date(`${date}T00:00:00Z`).getUTCDay()]} {date.slice(8)}</div>
              <div className="px-cal-col-body" style={{ height: BODY_HEIGHT }}>
                {/* hour grid lines */}
                {Array.from({ length: GRID_END_HOUR - GRID_START_HOUR }, (_, i) => (
                  <div key={i} className="px-cal-line" style={{ top: i * HOUR_PX }} />
                ))}

                {/* history layer: past time entries */}
                {agenda.entries.map((e) => {
                  const p = place(e.startsAt, e.endsAt);
                  if (p === null || p.col !== col) return null;
                  return (
                    <div key={e.id} className="px-cal-entry" style={{ top: p.top, height: p.height }} title={`${e.title} (logged)`}>
                      {e.title}
                    </div>
                  );
                })}

                {/* blocks */}
                {agenda.blocks.map((b) => {
                  const p = place(b.startsAt, b.endsAt);
                  if (p === null || p.col !== col) return null;
                  const cls = [
                    'px-cal-block',
                    b.status === 'suggested' ? 'px-cal-block--suggested' : '',
                    !b.justified ? 'px-cal-block--unjustified' : '',
                    b.anchored ? 'px-cal-block--anchored' : '',
                  ].filter(Boolean).join(' ');
                  return (
                    <div
                      key={b.id}
                      className={cls}
                      data-testid={`block-${b.id}`}
                      style={{ top: p.top, height: p.height, cursor: b.anchored ? 'not-allowed' : 'grab' }}
                      onMouseDown={(e) => {
                        if (b.status !== 'committed') return;
                        e.preventDefault();
                        startBlockDrag(b);
                      }}
                    >
                      <span className="px-cal-block-title">{b.anchored && <span aria-label="anchored">🔒 </span>}{b.title}</span>
                      {b.status === 'suggested' && (
                        <span className="px-cal-block-actions">
                          <button className="px-btn px-btn--primary" data-testid={`accept-${b.id}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => void commands.acceptSuggestion(b.id)}>✓</button>
                          <button className="px-btn px-btn--danger" data-testid={`reject-${b.id}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => void commands.rejectSuggestion(b.id)}>✕</button>
                        </span>
                      )}
                    </div>
                  );
                })}

                {/* drop overlay — only live during a drag */}
                {drag && (
                  <div className="px-cal-drop" data-testid={`drop-col-${col}`}>
                    {Array.from({ length: GRID_END_HOUR - GRID_START_HOUR }, (_, i) => {
                      const hour = GRID_START_HOUR + i;
                      const cellStart = localInstant(date, hour, tz);
                      const ok = cellValid(cellStart, drag.durationMs, drag.valid);
                      return (
                        <div
                          key={i}
                          className={`px-cal-cell ${ok ? 'px-cal-cell--valid' : 'px-cal-cell--invalid'}`}
                          data-testid={`cell-${col}-${hour}`}
                          data-valid={ok ? 'true' : 'false'}
                          style={{ top: i * HOUR_PX, height: HOUR_PX }}
                          onMouseUp={() => void dropAt(cellStart)}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
