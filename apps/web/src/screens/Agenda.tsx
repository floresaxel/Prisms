/**
 * Agenda (§12.2, §10 client mode): the day's note on the LEFT, the week calendar
 * in the middle, a to-do panel on the RIGHT. The right panel holds "To schedule"
 * (unplaced tasks) above a scrollable "All tasks" list — every live task, the
 * already-scheduled ones included. Both are dense flush lists rather than stacks
 * of cards: hairline-separated rows, each with a three-dot grip at its trailing
 * edge to say it picks up. Both lists drag onto the week: while dragging,
 * the valid time windows (core `validWindowsFor`, greedy mode) light up and
 * everything else dims; dropping in a valid slot creates a committed block.
 * Committed blocks drag to move; anchored blocks show a lock and refuse the drag
 * (I7). Suggested blocks render dashed with accept/reject (§2.6); blocks whose
 * ancestry reaches no vision render dark grey (§12.2); past time_entries are a
 * faint history layer.
 *
 * Drag is pointer-based (mousedown→mouseup) rather than HTML5 DnD so the live
 * window-hint state is observable mid-drag and it drives reliably in tests.
 *
 * While a drag is live the calendar shows exactly where the drop would land: a
 * dashed outline at the pointer's snapped position (its real duration, its real
 * start/end times) and the containing hour cell lit. The snap grid is the
 * Settings preference — 15 minutes unless changed — so the pointer places
 * things at a minute, not at an o'clock.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';

import {
  addDays,
  asEpochMillis,
  bucketDate,
  epochMillisToIso,
  expandWindows,
  localInstant,
  validWindowsFor,
  type Instant,
  type Interval,
  type SchedulableTask,
} from '@prisms/core';
import {
  Ic,
  isJournalContentEmpty,
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

import { conflictMessage, fitProblems, laneLayout, regionsInDay, type FitProblem } from '../agenda-fit';
import { agendaLayout, DAY_SPANS, DEFAULT_SPAN, GUTTER_W, isDaySpan } from '../agenda-layout';
import { formatAgendaRange, useRangeFormatPref } from '../agenda-range';
import { fmtGridClock, pointerMinutes, snapMinutes, useSnapPref } from '../agenda-snap';
import { DayJournalPanel } from '../components/DayJournal';
import { NoteSwap } from '../components/NoteSwap';
import { WhyButton } from '../components/Why';

const GRID_START_HOUR = 6;
const GRID_END_HOUR = 22;
const HOUR_PX = 44;
const MS_PER_MIN = 60_000;
const BODY_HEIGHT = (GRID_END_HOUR - GRID_START_HOUR) * HOUR_PX;
const BODY_MINUTES = (GRID_END_HOUR - GRID_START_HOUR) * 60;
const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SPAN_KEY = 'prisms.agenda.span';

/** Hover text for a to-do row: what it is, and what a drop would actually make. */
function rowTitle(t: AgendaTask): string {
  const parts = [t.task.title];
  if (t.kind === 'activity') parts.push('Inbox item — not under a project yet, so a block on it has no vision');
  if (!t.estimated) parts.push(`no estimate, drops as a ${t.schedulable.estimateMinutes}-minute event`);
  return parts.join(' — ');
}

/**
 * The section's own width, observed — drives both the stacking and the day count.
 * Measured rather than read off the viewport because the sidebar's rail toggle
 * changes the room available without the window resizing at all.
 */
function useMeasuredWidth(): [RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    // The one-shot measurement above is enough to render; only the LIVE reflow
    // needs an observer, so an environment without one (jsdom) still works.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w != null) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

interface DragState {
  taskId: string;
  durationMs: number;
  /** Set when moving an existing block rather than placing a new one. */
  blockId?: string;
  valid: Interval[];
  /** Shown on the card that follows the cursor. */
  title: string;
  /** Where the grab started, so the card appears under the cursor immediately. */
  originX: number;
  originY: number;
  /**
   * How far into the item the pointer grabbed it, in minutes. A block held by
   * its middle keeps that hold: the outline stays under the hand rather than
   * snapping its top up to the cursor. Always 0 for a fresh task, which has no
   * shape on the grid yet to hold.
   */
  grabOffsetMin: number;
}

/** Offset from the cursor so the card never sits under the pointer itself. */
const GHOST_DX = 14;
const GHOST_DY = 12;

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

  const [pageOffset, setPageOffset] = useState(0);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [span, setSpan] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem(SPAN_KEY));
      return isDaySpan(stored) ? stored : DEFAULT_SPAN;
    } catch {
      return DEFAULT_SPAN;
    }
  });
  const chooseSpan = (value: number) => {
    setSpan(value);
    setPageOffset(0); // pages are span-sized, so the old offset means something else
    try {
      localStorage.setItem(SPAN_KEY, String(value));
    } catch {
      /* preference is best-effort */
    }
  };

  const [viewRef, width] = useMeasuredWidth();
  const { stacked, narrow, perRow, rowCount, shownDays } = agendaLayout(width, span);
  const agenda = useAgenda(now);
  const commands = useCommands(ctx);
  const hydrated = useIsHydrated();
  const tz = agenda.input.timezone;
  const selectedBlock = agenda.blocks.find((b) => b.id === selectedBlockId) ?? null;

  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  /**
   * Where the drop would land right now: the day column under the pointer and
   * the snapped start, as minutes from the top of the grid. Two primitives
   * rather than one object on purpose — React bails out of the re-render when a
   * `useState` setter is handed the value it already holds, so the (heavy)
   * Agenda re-renders once per crossed snap line rather than once per pointer
   * sample. The same trick keeps the resize drag below cheap.
   */
  const snap = useSnapPref();
  const rangeFormat = useRangeFormatPref();
  const [previewCol, setPreviewCol] = useState<number | null>(null);
  const [previewMin, setPreviewMin] = useState<number | null>(null);
  const clearPreview = () => {
    setPreviewCol(null);
    setPreviewMin(null);
  };

  // cancel a drag that ends anywhere other than a valid cell
  useEffect(() => {
    const onUp = () => {
      setDrag(null);
      clearPreview();
    };
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
    const base = addDays(bucketDate(now, 0, tz), pageOffset * shownDays);
    return Array.from({ length: shownDays }, (_, i) => addDays(base, i));
  }, [now, tz, pageOffset, shownDays]);

  /** `days` split into the rendered rows (one grid each). */
  const dayRows = useMemo(
    () => Array.from({ length: rowCount }, (_, r) => days.slice(r * perRow, (r + 1) * perRow)),
    [days, rowCount, perRow],
  );

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
  // Keyed on TEXT, not on row presence: a day whose note is empty is not a day
  // with a note, so it must not wear the marker. (New writes never store a blank
  // note, but rows predating that rule — and a not-yet-synced delete — can be.)
  const noteByDate = useMemo(
    () => new Map(journal.entries.filter((e) => !isJournalContentEmpty(e.content)).map((e) => [e.entry_date, e.content])),
    [journal.entries],
  );

  const colIndexOf = (start: Instant): number => days.indexOf(bucketDate(start, 0, tz));

  function place(start: Instant, end: Instant): { col: number; top: number; height: number } | null {
    const col = colIndexOf(start);
    if (col < 0) return null;
    const base = localInstant(days[col]!, GRID_START_HOUR, tz);
    const top = ((start - base) / MS_PER_MIN / 60) * HOUR_PX;
    const height = Math.max(16, ((end - start) / MS_PER_MIN / 60) * HOUR_PX);
    return { col, top, height };
  }

  function startTaskDrag(task: SchedulableTask, title: string, e: ReactMouseEvent) {
    setDrag({
      taskId: task.id,
      durationMs: task.estimateMinutes * MS_PER_MIN,
      valid: validWindowsFor(task, agenda.input),
      title,
      originX: e.clientX,
      originY: e.clientY,
      grabOffsetMin: 0, // a list row has no height on the grid to hold on to
    });
  }

  /** Drag lookup over EVERYTHING listed, not just `tasksById` — that map is the
   *  scheduler's view (estimated tasks only), so a block on an estimate-less task
   *  or an Inbox item would otherwise be un-draggable once placed. */
  const schedulableById = useMemo(
    () => new Map(agenda.allTasks.map((t) => [t.task.id, t.schedulable])),
    [agenda.allTasks],
  );

  function startBlockDrag(block: AgendaBlock, e: ReactMouseEvent) {
    if (block.anchored) return; // I7: anchored blocks refuse the drag
    const task = schedulableById.get(block.taskId);
    if (!task) return;
    const top = e.currentTarget.getBoundingClientRect().top;
    setDrag({
      taskId: block.taskId,
      blockId: block.id,
      durationMs: task.estimateMinutes * MS_PER_MIN,
      valid: validWindowsFor(task, agenda.input),
      title: block.title,
      originX: e.clientX,
      originY: e.clientY,
      grabOffsetMin: ((e.clientY - top) / HOUR_PX) * 60,
    });
  }

  /**
   * The card that follows the cursor. Positioned IMPERATIVELY on mousemove: the
   * Agenda re-render is heavy (a week of blocks plus two task lists), and doing
   * it per pointer sample would make the drag stutter. React owns whether the
   * card exists; the mouse owns where it is.
   */
  const ghostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const el = ghostRef.current;
      if (el) el.style.transform = `translate3d(${e.clientX + GHOST_DX}px, ${e.clientY + GHOST_DY}px, 0)`;
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [drag]);

  /**
   * The hours work may land in, over the DISPLAYED days rather than the
   * scheduler's horizon — otherwise paging back a week would leave every block
   * on it with no window to be inside of, and the whole page would wear a
   * caution.
   */
  const dayHours = useMemo(
    () =>
      expandWindows(agenda.input.windows, tz, {
        from: localInstant(days[0]!, 0, tz),
        to: localInstant(days.at(-1)!, 24, tz),
      }),
    [agenda.input.windows, tz, days],
  );

  /** Committed blocks are what a placement can collide with. */
  const committedSpans = useMemo(
    () =>
      agenda.blocks
        .filter((b) => b.status === 'committed')
        .map((b) => ({ id: b.id, start: b.startsAt, end: b.endsAt })),
    [agenda.blocks],
  );

  /**
   * §I7-adjacent: a drop is no longer refused, so what used to be an invalid
   * region is now merely a clash — computed once per block and worn as a
   * caution glyph. Excludes the block itself; a block cannot clash with itself.
   */
  const problemsByBlock = useMemo(() => {
    const map = new Map<string, FitProblem[]>();
    for (const b of agenda.blocks) {
      const others = committedSpans.filter((s) => s.id !== b.id);
      map.set(b.id, fitProblems({ start: b.startsAt, end: b.endsAt }, others, dayHours));
    }
    return map;
  }, [agenda.blocks, committedSpans, dayHours]);

  /** Overlapping blocks share the column instead of hiding one another. */
  const lanes = useMemo(
    () => laneLayout(agenda.blocks.map((b) => ({ id: b.id, start: b.startsAt, end: b.endsAt }))),
    [agenda.blocks],
  );

  /**
   * Where the dragged item actually fits, per day column, as one merged shape
   * per continuous stretch. Recomputed once per drag (the drag object's
   * identity is stable through the pointer's travel), not per pointer sample.
   */
  const fitRegions = useMemo(
    () => (drag ? days.map((d) => regionsInDay(drag.valid, localInstant(d, GRID_START_HOUR, tz), BODY_MINUTES)) : null),
    [drag, days, tz],
  );

  /**
   * Pointer → the snapped start it means, as minutes from the top of the grid.
   * The last snap line is left clear of the grid's end so the last slot of the
   * day is always reachable; an item longer than the room left simply overhangs
   * the bottom, exactly as an equivalent block would.
   */
  const minutesAt = (clientY: number, rectTop: number, d: DragState): number =>
    snapMinutes(pointerMinutes(clientY, rectTop, HOUR_PX, d.grabOffsetMin), snap, BODY_MINUTES - snap);

  /** Minutes from the top of the grid → the instant that reads as on `date`. */
  const instantAt = (date: string, minutes: number): Instant => localInstant(date, GRID_START_HOUR, tz, minutes);

  /**
   * What would be wrong with dropping the held item at `start` — the same
   * question `problemsByBlock` asks of a block that has already landed, so the
   * outline's warning and the block's caution always agree. A block being MOVED
   * does not collide with the copy of itself it is about to leave behind.
   */
  const problemsAt = (start: Instant, d: DragState): FitProblem[] =>
    fitProblems(
      { start, end: start + d.durationMs },
      committedSpans.filter((s) => s.id !== d.blockId),
      dayHours,
    );

  /** A drop is never refused (§12.2): anywhere is allowed, a clash is flagged. */
  async function dropAt(cellStart: Instant) {
    const d = dragRef.current;
    if (!d) return;
    const startsAt = epochMillisToIso(cellStart);
    const endsAt = epochMillisToIso(asEpochMillis(cellStart + d.durationMs));
    if (d.blockId) await commands.moveBlock(d.blockId, startsAt, endsAt);
    else await commands.createBlock({ taskId: d.taskId, startsAt, endsAt });
    setDrag(null);
    clearPreview();
  }

  return (
    <section className="px-agenda-view" ref={viewRef as RefObject<HTMLElement>}>
      <div className="px-page-head">
        <h1>Agenda</h1>
        {/* The label's shape is a Settings preference; the days it names are not. */}
        <span className="px-page-sub" data-testid="week-range">
          {formatAgendaRange(days[0] ?? '', days.at(-1) ?? '', rangeFormat)}
        </span>
        {shownDays < span && (
          <span className="px-page-sub" data-testid="span-capped">showing {shownDays} of {span} — widen the window for more</span>
        )}
        <div className="px-head-actions">
          <div className="px-seg" role="group" aria-label="days shown" data-testid="span-picker">
            {DAY_SPANS.map((s) => (
              <button
                key={s.value}
                className={`px-seg-btn${span === s.value ? ' px-seg-btn--on' : ''}`}
                data-testid={`span-${s.value}`}
                aria-pressed={span === s.value}
                title={s.label}
                onClick={() => chooseSpan(s.value)}
              >
                {s.short}
              </button>
            ))}
          </div>
          <button className="px-btn px-btn--icon" data-testid="week-prev" aria-label="previous period" onClick={() => setPageOffset((w) => w - 1)}><Ic name="chevl" /></button>
          <button className="px-btn" data-testid="week-today" onClick={() => setPageOffset(0)}>Today</button>
          <button className="px-btn px-btn--icon" data-testid="week-next" aria-label="next period" onClick={() => setPageOffset((w) => w + 1)}><Ic name="chevr" /></button>
        </div>
      </div>

      <div className="px-ag-bar">
        <span className="px-page-sub">Drag any task onto the week — the free stretches glow. Drop anywhere; a clash is flagged, not refused.</span>
        <div className="px-ag-legend">
          <span className="px-lg"><span className="px-ag-sw px-ag-sw--committed" />Committed</span>
          <span className="px-lg"><span className="px-ag-sw px-ag-sw--anchored" />Anchored 🔒</span>
          <span className="px-lg"><span className="px-ag-sw px-ag-sw--suggested" />Suggested</span>
          <span className="px-lg"><span className="px-ag-sw px-ag-sw--novision" />No vision</span>
          <span className="px-lg"><span className="px-ag-sw px-ag-sw--history" />History</span>
          <span className="px-lg"><Ic name="alert" className="px-ag-sw-ic" />Clash</span>
        </div>
      </div>

      <div
        className={`px-agenda${stacked ? ' px-agenda--stack' : ''}${narrow ? ' px-agenda--narrow' : ''}`}
        data-testid="agenda-layout"
        data-layout={stacked ? (narrow ? 'narrow' : 'stack') : 'cols'}
        style={drag || resize ? { userSelect: 'none' } : undefined}
      >
        {/* journal / event-tags panel (left) */}
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
            // `lock`: just the lock/pencil toggle here — managing the note
            // (export, delete) belongs to the Journal screen. NoteSwap holds the
            // outgoing day on screen long enough to fade it out.
            <NoteSwap swapKey={journalDay}>
              <DayJournalPanel key={journalDay} date={journalDay} ctx={ctx} actions="lock" />
            </NoteSwap>
          )}
        </div>

        <div className="px-agenda-cal">
        {/* one grid per row — a span over a week wraps, and a narrow window
            simply gets fewer columns rather than a sideways scrollbar. */}
        <div className="px-cal-rows">
        {dayRows.map((rowDays, r) => (
        <div
          key={r}
          className="px-cal-grid"
          data-testid={`cal-row-${r}`}
          style={{ gridTemplateColumns: `${GUTTER_W}px repeat(${rowDays.length}, minmax(0, 1fr))` }}
        >
          <div className="px-cal-gutter" style={{ height: BODY_HEIGHT }}>
            {Array.from({ length: GRID_END_HOUR - GRID_START_HOUR }, (_, i) => (
              <div key={i} className="px-cal-hour-label" style={{ top: i * HOUR_PX }}>{fmtHour(GRID_START_HOUR + i)}</div>
            ))}
          </div>

          {rowDays.map((date, i) => {
            const col = r * perRow + i;
            // The drop preview belongs to whichever column the pointer is over:
            // minutes from the top of the grid, and the hour that contains them.
            const preview = drag && previewCol === col && previewMin !== null ? previewMin : null;
            const previewHour = preview === null ? -1 : GRID_START_HOUR + Math.floor(preview / 60);
            return (
            <div
              key={date}
              className={`px-cal-col${selectedDay === date ? ' px-cal-col--sel' : ''}`}
              data-testid={`day-${col}`}
              data-selected={selectedDay === date ? 'true' : undefined}
            >
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
                {/* testid keeps the `note-dot-` name the specs already address it by. */}
                {noteByDate.has(date) && (
                  <span className="px-note-ic" data-testid={`note-dot-${date}`} role="img" aria-label="has note">
                    <Ic name="note" />
                  </span>
                )}
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
                  const problems = problemsByBlock.get(b.id) ?? [];
                  const clash = conflictMessage(problems);
                  const { lane, lanes: laneCount } = lanes.get(b.id) ?? { lane: 0, lanes: 1 };
                  const cls = [
                    'px-cal-block',
                    b.status === 'suggested' ? 'px-cal-block--suggested' : '',
                    b.superseded ? 'px-cal-block--superseded' : '',
                    !b.justified ? 'px-cal-block--unjustified' : '',
                    b.anchored ? 'px-cal-block--anchored' : '',
                    clash ? 'px-cal-block--clash' : '',
                  ].filter(Boolean).join(' ');
                  return (
                    <div
                      key={b.id}
                      className={cls}
                      data-testid={`block-${b.id}`}
                      data-duration-min={Math.round((endForDisplay - b.startsAt) / MS_PER_MIN)}
                      data-conflict={clash ? 'true' : 'false'}
                      style={{
                        top: p.top,
                        height: p.height,
                        // lanes, so a clashing block sits BESIDE what it clashes
                        // with rather than under it — hiding its own caution.
                        left: `${(lane / laneCount) * 100}%`,
                        right: `${((laneCount - lane - 1) / laneCount) * 100}%`,
                        cursor: b.anchored ? 'not-allowed' : 'grab',
                        outline: b.id === selectedBlockId ? '2px solid var(--px-accent, #4c8bf5)' : undefined,
                      }}
                      onMouseDown={(e) => {
                        if (b.status !== 'committed') return;
                        e.preventDefault();
                        startBlockDrag(b, e);
                      }}
                      onClick={() => {
                        setSelectedBlockId(b.id);
                        setSelectedDay(null);
                      }}
                    >
                      {clash && (
                        <span className="px-cal-warn" data-testid={`conflict-${b.id}`} data-problems={problems.join(' ')}>
                          {/* `title` is both the hover text and the icon's accessible name */}
                          <Ic name="alert" title={clash} />
                        </span>
                      )}
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

                {/* drop overlay — only live during a drag. The pointer is read
                    on the overlay rather than per cell, because a snapped drop
                    can start anywhere inside an hour (or, once grabbed
                    mid-block, inside the one above it). */}
                {drag && (
                  <div
                    className="px-cal-drop"
                    data-testid={`drop-col-${col}`}
                    onMouseMove={(e) => {
                      const min = minutesAt(e.clientY, e.currentTarget.getBoundingClientRect().top, drag);
                      setPreviewCol(col);
                      setPreviewMin(min);
                    }}
                    // guarded: the pointer enters the next column before this
                    // fires, so an unguarded clear would blank that fresh preview
                    onMouseLeave={() => setPreviewCol((c) => (c === col ? null : c))}
                    onMouseUp={(e) => {
                      const min = minutesAt(e.clientY, e.currentTarget.getBoundingClientRect().top, drag);
                      void dropAt(instantAt(date, min));
                    }}
                  >
                    {/* where it fits: ONE glowing outline per continuous free
                        stretch, not a stack of hour-sized rectangles. */}
                    {(fitRegions?.[col] ?? []).map((r) => (
                      <div
                        key={r.startMin}
                        className="px-cal-free"
                        data-testid={`free-${col}-${r.startMin}`}
                        data-span-min={r.endMin - r.startMin}
                        aria-hidden="true"
                        style={{ top: (r.startMin / 60) * HOUR_PX, height: ((r.endMin - r.startMin) / 60) * HOUR_PX }}
                      />
                    ))}

                    {/* the hour the drop would fall in */}
                    {previewHour >= 0 && (
                      <div
                        className="px-cal-hot"
                        data-testid={`hot-hour-${col}`}
                        data-hour={previewHour}
                        aria-hidden="true"
                        style={{ top: (previewHour - GRID_START_HOUR) * HOUR_PX, height: HOUR_PX }}
                      />
                    )}

                    {/* what the drop would make, drawn where it would go */}
                    {preview !== null && (() => {
                      const durMin = drag.durationMs / MS_PER_MIN;
                      const problems = problemsAt(instantAt(date, preview), drag);
                      const clash = conflictMessage(problems);
                      return (
                        <div
                          className={`px-cal-preview${clash ? ' px-cal-preview--clash' : ''}`}
                          data-testid={`drop-preview-${col}`}
                          data-start-min={preview}
                          data-conflict={clash ? 'true' : 'false'}
                          data-problems={problems.join(' ')}
                          aria-hidden="true"
                          style={{ top: (preview / 60) * HOUR_PX, height: Math.max(16, (durMin / 60) * HOUR_PX) }}
                        >
                          <span className="px-cal-preview-time">
                            {clash && <Ic name="alert" className="px-cal-preview-warn" />}
                            {fmtGridClock(GRID_START_HOUR, preview)} – {fmtGridClock(GRID_START_HOUR, preview + durMin)}
                          </span>
                          <span className="px-cal-preview-title">{drag.title}</span>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            </div>
            );
          })}
        </div>
        ))}
        </div>
      </div>

        {/* to-schedule + all tasks (right) — every row drags onto the week */}
        <div className="px-agenda-todo">
          <h2>To schedule <span className="px-muted">{agenda.todo.length}</span></h2>
          <div data-testid="todo-list" className="px-todo-list">
            {agenda.todo.length === 0 &&
              (hydrated ? <div className="px-list-empty">Nothing to place.</div> : <Skeleton testId="todo-skeleton" rows={4} />)}
            {agenda.todo.map((t: AgendaTask) => (
              <div
                key={t.task.id}
                className={`px-todo-item${t.kind === 'activity' ? ' px-todo-item--inbox' : ''}${drag?.taskId === t.task.id ? ' px-todo-item--dragging' : ''}`}
                data-testid={`todo-${t.task.id}`}
                data-kind={t.kind}
                title={rowTitle(t)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  startTaskDrag(t.schedulable, t.task.title, e);
                }}
              >
                <span className="px-todo-title">{t.task.title}</span>
                <span className="px-todo-sub">
                  {t.kind === 'activity' && <span className="px-tag px-tag--grey px-todo-flag">inbox</span>}
                  {t.estimated ? '' : '~'}{t.schedulable.estimateMinutes}m
                </span>
                <span className="px-todo-grip"><Ic name="dots" /></span>
              </div>
            ))}
          </div>

          {/* Everything still open, scheduled ones included — bounded scroller so
              the panel never outgrows the week grid. */}
          <div className="px-ag-all">
            <h2>All tasks <span className="px-muted">{agenda.allTasks.length}</span></h2>
            <div className="px-ag-scroll px-todo-list" data-testid="all-tasks-list">
              {agenda.allTasks.length === 0 &&
                (hydrated ? <div className="px-list-empty">No open tasks.</div> : <Skeleton testId="all-tasks-skeleton" rows={4} />)}
              {agenda.allTasks.map((t: AgendaTask) => (
                <div
                  key={t.task.id}
                  className={`px-todo-item${t.scheduled ? ' px-todo-item--placed' : ''}${t.kind === 'activity' ? ' px-todo-item--inbox' : ''}${drag?.taskId === t.task.id ? ' px-todo-item--dragging' : ''}`}
                  data-testid={`alltask-${t.task.id}`}
                  data-kind={t.kind}
                  title={rowTitle(t)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    startTaskDrag(t.schedulable, t.task.title, e);
                  }}
                >
                  <span className="px-todo-title">{t.task.title}</span>
                  <span className="px-todo-sub">
                    {t.kind === 'activity' && <span className="px-tag px-tag--grey px-todo-flag">inbox</span>}
                    {t.scheduled ? 'scheduled · ' : ''}
                    {t.estimated ? '' : '~'}
                    {t.schedulable.estimateMinutes}m
                  </span>
                  <span className="px-todo-grip"><Ic name="dots" /></span>
                </div>
              ))}
            </div>
          </div>
          <p className="px-muted px-drag-hint" data-testid="drag-hint">
            Drops snap to {snap === 60 ? '1 hour' : `${snap} minutes`} — change that in Settings. Anchored blocks refuse
            the drag (🔒); everywhere else takes a drop, and one that overlaps or falls outside your hours keeps a
            caution ⚠ until you move it.
          </p>
        </div>
      </div>

      {/* The grabbed item, following the cursor until it is dropped. `pointer-events:
          none` is load-bearing: without it the card sits under the pointer and eats
          the mouseup that the calendar cell needs to receive the drop. */}
      {drag && (
        <div
          ref={ghostRef}
          className="px-drag-ghost"
          data-testid="drag-ghost"
          aria-hidden="true"
          style={{ transform: `translate3d(${drag.originX + GHOST_DX}px, ${drag.originY + GHOST_DY}px, 0)` }}
        >
          <span className="px-drag-ghost-title">{drag.title}</span>
          <span className="px-drag-ghost-dur">{Math.round(drag.durationMs / MS_PER_MIN)}m</span>
        </div>
      )}
    </section>
  );
}
