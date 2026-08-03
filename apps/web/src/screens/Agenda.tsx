/**
 * Agenda (§12.2, §10 client mode): a to-do panel on the LEFT, the week calendar
 * in the middle, the day's note on the RIGHT. The left panel holds "To schedule"
 * (unplaced tasks) above a scrollable "All tasks" list — every live task, the
 * already-scheduled ones included. Both lists drag onto the week: while dragging,
 * the valid time windows (core `validWindowsFor`, greedy mode) light up and
 * everything else dims; dropping in a valid slot creates a committed block.
 * Committed blocks drag to move; anchored blocks show a lock and refuse the drag
 * (I7). Suggested blocks render dashed with accept/reject (§2.6); blocks whose
 * ancestry reaches no vision render dark grey (§12.2); past time_entries are a
 * faint history layer.
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
import {
  Ic,
  Skeleton,
  truncatePlain,
  useAgenda,
  useBlockTags,
  useCommands,
  useIsHydrated,
  useJournalMonths,
  useTagCatalog,
  type AgendaBlock,
  type AgendaTask,
  type BlockTagView,
  type CommandContext,
} from '@prisms/ui';

import { DayJournalPanel } from '../components/DayJournal';
import { WhyButton } from '../components/Why';

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

const ANSWER_COLOR: Record<BlockTagView['answer'], string> = {
  yes: 'var(--px-ok, #2e7d32)',
  no: 'var(--px-danger, #c62828)',
  pending: 'var(--px-dim, #888)',
};

/**
 * Confirmable tags on a selected event (§ tags): each placed tag shows a
 * Yes/No/pending tri-state; tags come from a reusable catalog (add an existing
 * one or create a new one inline). Pending is a real state — it persists even
 * after the event/task is completed.
 */
function BlockTagsPanel({ blockId, title, ctx }: { blockId: string; title: string; ctx: CommandContext }) {
  const tags = useBlockTags(blockId);
  const catalog = useTagCatalog();
  const commands = useCommands(ctx);
  const [newLabel, setNewLabel] = useState('');

  const placed = new Set(tags.map((t) => t.tag.id));
  const available = catalog.filter((t) => !placed.has(t.id));

  async function setAnswer(view: BlockTagView, value: 'yes' | 'no') {
    // tapping the current answer again clears it back to pending
    if (view.answer === value) {
      if (view.answerId) await commands.clearTagAnswer(view.answerId);
      return;
    }
    await commands.answerTag({ existingId: view.answerId ?? undefined, placementId: view.placementId, value });
  }

  async function createAndPlace() {
    const label = newLabel.trim();
    if (!label) return;
    const tagId = await commands.createTag({ label });
    await commands.placeTag({ blockId, tagId });
    setNewLabel('');
  }

  return (
    <div className="px-block-tags" data-testid={`block-tags-${blockId}`} style={{ marginTop: 16 }}>
      <h2 style={{ marginBottom: 4 }}>Tags</h2>
      <p className="px-muted" style={{ marginTop: 0 }}>{title}</p>
      {tags.length === 0 && <p className="px-muted">No tags on this event yet.</p>}
      {tags.map((t) => (
        <div
          key={t.placementId}
          data-testid={`tag-${blockId}-${t.tag.id}`}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}
        >
          <span style={{ flex: 1 }}>{t.tag.label}</span>
          <span data-testid={`tag-state-${t.placementId}`} style={{ color: ANSWER_COLOR[t.answer], fontSize: 12 }}>
            {t.answer}
          </span>
          <button
            className="px-btn"
            data-testid={`tag-yes-${t.placementId}`}
            aria-pressed={t.answer === 'yes'}
            style={t.answer === 'yes' ? { borderColor: ANSWER_COLOR.yes } : undefined}
            onClick={() => void setAnswer(t, 'yes')}
          >
            Yes
          </button>
          <button
            className="px-btn"
            data-testid={`tag-no-${t.placementId}`}
            aria-pressed={t.answer === 'no'}
            style={t.answer === 'no' ? { borderColor: ANSWER_COLOR.no } : undefined}
            onClick={() => void setAnswer(t, 'no')}
          >
            No
          </button>
          <button className="px-btn px-btn--danger" aria-label="remove tag" onClick={() => void commands.unplaceTag(t.placementId)}>×</button>
        </div>
      ))}

      {available.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {available.map((t) => (
            <button key={t.id} className="px-btn" data-testid={`place-tag-${t.id}`} onClick={() => void commands.placeTag({ blockId, tagId: t.id })}>
              + {t.label}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input
          placeholder="New tag (e.g. on time?)"
          data-testid="new-tag-label"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="px-btn px-btn--primary" data-testid="create-tag" onClick={() => void createAndPlace()}>Add</button>
      </div>
    </div>
  );
}

export function Agenda({ ctx }: { ctx: CommandContext }) {
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 60_000);
    return () => clearInterval(t);
  }, []);

  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const agenda = useAgenda(now);
  const commands = useCommands(ctx);
  const hydrated = useIsHydrated();
  const tz = agenda.input.timezone;
  const selectedBlock = agenda.blocks.find((b) => b.id === selectedBlockId) ?? null;

  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  // cancel a drag that ends anywhere other than a valid cell
  useEffect(() => {
    const onUp = () => setDrag(null);
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, []);

  // resize: drag a committed block's bottom edge to change its end (block.move),
  // snapped to 15-minute steps. Independent of the move/create drag above.
  const [resize, setResize] = useState<{ blockId: string; startInstant: Instant; originEnd: Instant; startY: number } | null>(null);
  const [resizeEnd, setResizeEnd] = useState<Instant | null>(null);
  const resizeEndRef = useRef<Instant | null>(null);
  resizeEndRef.current = resizeEnd;

  useEffect(() => {
    if (!resize) return;
    const onMove = (e: MouseEvent) => {
      const deltaMin = Math.round((((e.clientY - resize.startY) / HOUR_PX) * 60) / 15) * 15;
      const minEnd = resize.startInstant + 15 * MS_PER_MIN;
      setResizeEnd(asEpochMillis(Math.max(minEnd, resize.originEnd + deltaMin * MS_PER_MIN)));
    };
    const onUp = () => {
      const end = resizeEndRef.current;
      setResize(null);
      setResizeEnd(null);
      if (end !== null && end !== resize.originEnd) {
        void commands.moveBlock(resize.blockId, epochMillisToIso(resize.startInstant), epochMillisToIso(end));
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resize, commands]);

  const days = useMemo(() => {
    const base = addDays(bucketDate(now, 0, tz), weekOffset * 7);
    return Array.from({ length: 7 }, (_, i) => addDays(base, i));
  }, [now, tz, weekOffset]);

  // The journal panel shows today's note by default; a day-header click swaps it
  // to that day and a block click swaps it to the block's tags. todayDate is
  // fixed — independent of the browsed week.
  const todayDate = useMemo(() => bucketDate(now, 0, tz), [now, tz]);
  const journalDay = selectedDay ?? todayDate;

  // §7.3/D3: hold the visible week's month(s) — a week can span two, so subscribe
  // BOTH — so the day-header note dots reflect synced notes. Lazy: nothing outside
  // the viewed months ever syncs.
  const months = useMemo(() => [...new Set(days.map((d) => d.slice(0, 7)))], [days]);
  const journal = useJournalMonths(months);
  const noteByDate = useMemo(() => new Map(journal.entries.map((e) => [e.entry_date, e.content])), [journal.entries]);

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
    <section className="px-agenda-view">
      <div className="px-page-head">
        <h1>Agenda</h1>
        <span className="px-page-sub" data-testid="week-range">{days[0]} – {days[6]}</span>
        <div className="px-head-actions">
          <button className="px-btn px-btn--icon" data-testid="week-prev" aria-label="previous week" onClick={() => setWeekOffset((w) => w - 1)}><Ic name="chevl" /></button>
          <button className="px-btn" data-testid="week-today" onClick={() => setWeekOffset(0)}>Today</button>
          <button className="px-btn px-btn--icon" data-testid="week-next" aria-label="next week" onClick={() => setWeekOffset((w) => w + 1)}><Ic name="chevr" /></button>
        </div>
      </div>

      <div className="px-ag-bar">
        <span className="px-page-sub">Drag any task onto the week — valid windows light up, everything else dims.</span>
        <div className="px-ag-legend">
          <span className="px-lg"><span className="px-ag-sw px-ag-sw--committed" />Committed</span>
          <span className="px-lg"><span className="px-ag-sw px-ag-sw--anchored" />Anchored 🔒</span>
          <span className="px-lg"><span className="px-ag-sw px-ag-sw--suggested" />Suggested</span>
          <span className="px-lg"><span className="px-ag-sw px-ag-sw--novision" />No vision</span>
          <span className="px-lg"><span className="px-ag-sw px-ag-sw--history" />History</span>
        </div>
      </div>

      <div className="px-agenda" style={drag || resize ? { userSelect: 'none' } : undefined}>
        {/* to-schedule + all tasks (left) — every row drags onto the week */}
        <div className="px-agenda-todo">
          <h2>To schedule <span className="px-muted">{agenda.todo.length}</span></h2>
          <div data-testid="todo-list" className="px-list">
            {agenda.todo.length === 0 &&
              (hydrated ? <div className="px-list-empty">Nothing to place.</div> : <Skeleton testId="todo-skeleton" rows={4} />)}
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
                <span className="px-todo-title">{task.title}</span>
                <span className="px-todo-sub">{schedulable.estimateMinutes}m</span>
              </div>
            ))}
          </div>

          {/* Everything still open, scheduled ones included — bounded scroller so
              the panel never outgrows the week grid. */}
          <div className="px-ag-all">
            <h2>All tasks <span className="px-muted">{agenda.allTasks.length}</span></h2>
            <div className="px-ag-scroll" data-testid="all-tasks-list">
              {agenda.allTasks.length === 0 &&
                (hydrated ? <div className="px-list-empty">No open tasks.</div> : <Skeleton testId="all-tasks-skeleton" rows={4} />)}
              {agenda.allTasks.map((t: AgendaTask) => (
                <div
                  key={t.task.id}
                  className={`px-todo-item${t.scheduled ? ' px-todo-item--placed' : ''}`}
                  data-testid={`alltask-${t.task.id}`}
                  title={t.estimated ? t.task.title : `${t.task.title} — no estimate, drops as a ${t.schedulable.estimateMinutes}-minute event`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    startTaskDrag(t.schedulable);
                  }}
                >
                  <span className="px-todo-title">{t.task.title}</span>
                  <span className="px-todo-sub">
                    {t.scheduled ? 'scheduled · ' : ''}
                    {t.estimated ? '' : '~'}
                    {t.schedulable.estimateMinutes}m
                  </span>
                </div>
              ))}
            </div>
          </div>
          <p className="px-muted px-drag-hint">Anchored blocks refuse the drag (🔒). A drop outside a valid window snaps back.</p>
        </div>

        <div className="px-agenda-cal">
        <div className="px-cal-grid">
          <div className="px-cal-gutter" style={{ height: BODY_HEIGHT }}>
            {Array.from({ length: GRID_END_HOUR - GRID_START_HOUR }, (_, i) => (
              <div key={i} className="px-cal-hour-label" style={{ top: i * HOUR_PX }}>{fmtHour(GRID_START_HOUR + i)}</div>
            ))}
          </div>

          {days.map((date, col) => (
            <div key={date} className="px-cal-col" data-testid={`day-${col}`}>
              <div
                className={`px-cal-col-head${selectedDay === date ? ' px-cal-col-head--sel' : ''}`}
                data-testid={`day-head-${col}`}
                role="button"
                tabIndex={0}
                title={noteByDate.has(date) ? truncatePlain(noteByDate.get(date)!, 80) : 'Add a note for this day'}
                onClick={() => {
                  setSelectedDay(date);
                  setSelectedBlockId(null);
                }}
              >
                {DAY_LABEL[new Date(`${date}T00:00:00Z`).getUTCDay()]} {date.slice(8)}
                {noteByDate.has(date) && <span className="px-note-dot" data-testid={`note-dot-${date}`} aria-label="has note" />}
              </div>
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
                  const resizing = resize?.blockId === b.id && resizeEnd !== null;
                  const endForDisplay = resizing ? (resizeEnd as Instant) : b.endsAt;
                  const p = place(b.startsAt, endForDisplay);
                  if (p === null || p.col !== col) return null;
                  const cls = [
                    'px-cal-block',
                    b.status === 'suggested' ? 'px-cal-block--suggested' : '',
                    b.superseded ? 'px-cal-block--superseded' : '',
                    !b.justified ? 'px-cal-block--unjustified' : '',
                    b.anchored ? 'px-cal-block--anchored' : '',
                  ].filter(Boolean).join(' ');
                  return (
                    <div
                      key={b.id}
                      className={cls}
                      data-testid={`block-${b.id}`}
                      data-duration-min={Math.round((endForDisplay - b.startsAt) / MS_PER_MIN)}
                      style={{ top: p.top, height: p.height, cursor: b.anchored ? 'not-allowed' : 'grab', outline: b.id === selectedBlockId ? '2px solid var(--px-accent, #4c8bf5)' : undefined }}
                      onMouseDown={(e) => {
                        if (b.status !== 'committed') return;
                        e.preventDefault();
                        startBlockDrag(b);
                      }}
                      onClick={() => {
                        setSelectedBlockId(b.id);
                        setSelectedDay(null);
                      }}
                    >
                      <span className="px-cal-block-title">{b.anchored && <span aria-label="anchored">🔒 </span>}{b.title}</span>
                      {b.superseded && (
                        <span className="px-cal-block-stale" data-testid={`superseded-${b.id}`}>superseded</span>
                      )}
                      {b.status === 'suggested' && (
                        <span className="px-cal-block-actions">
                          <button className="px-btn px-btn--primary" data-testid={`accept-${b.id}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => void commands.acceptSuggestion(b.id)}>✓</button>
                          <button className="px-btn px-btn--danger" data-testid={`reject-${b.id}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => void commands.rejectSuggestion(b.id)}>✕</button>
                        </span>
                      )}
                      {b.status === 'committed' && !b.anchored && (
                        <div
                          className="px-cal-resize"
                          data-testid={`resize-${b.id}`}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            setResize({ blockId: b.id, startInstant: b.startsAt, originEnd: b.endsAt, startY: e.clientY });
                            setResizeEnd(b.endsAt);
                          }}
                        />
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

        {/* journal / event-tags panel (right) */}
        <div className="px-agenda-journal">
          {selectedBlock ? (
            <>
              <div className="px-why-inline" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="px-muted">{selectedBlock.status === 'suggested' ? 'Suggested event' : 'Event'}</span>
                <WhyButton row={selectedBlock.provenance} suggestionReason={selectedBlock.suggestionReason} testId={`why-block-${selectedBlock.id}`} />
              </div>
              <BlockTagsPanel blockId={selectedBlock.id} title={selectedBlock.title} ctx={ctx} />
            </>
          ) : (
            // key by day so the editor re-initializes per day (J4/D3); defaults to today.
            <DayJournalPanel key={journalDay} date={journalDay} ctx={ctx} />
          )}
        </div>
      </div>
    </section>
  );
}
