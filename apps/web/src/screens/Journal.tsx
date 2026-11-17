/**
 * Journal (web redesign W6) — a standalone month browser around the existing
 * day-note editor. The month list is LAZY: a month subscribes its rows only
 * when expanded (the ref-counted `useJournalMonths` manager, shared with the
 * Agenda's day panel), so years of journaling never weigh down sync — collapsed
 * months show no note count precisely because they were never pulled. The
 * current month opens expanded; picking any day loads it in the `DayJournalPanel`
 * editor. The .zip archive download lives only in Settings › Data & portability
 * (server-sourced: every month, even ones never synced to this device).
 *
 * Two ways to read the list — BY DATE (months, newest first) or BY TAG (one group
 * per tag, a note listed under each tag it carries) — and a filter on tag, project
 * and vision. The project / vision filter narrows to days whose generated day log
 * touches that project or vision (clocked time, scheduled or completed work), and
 * is the same filter the day-log footer under an open note uses.
 *
 * Reading by tag needs every month's notes, so that mode holds the last
 * MONTHS_SHOWN months' subscriptions while it is open; by-date mode still only
 * holds the months you have expanded.
 */
import { useMemo, useState } from 'react';

import { asEpochMillis, dayLogRefs, filterDayLog, type DayLogRef, type Instant, type JournalEntry } from '@prisms/core';
import {
  Ic,
  isJournalContentEmpty,
  journalTitleOf,
  truncatePlain,
  useDayLogsByDate,
  useFactContext,
  useJournalMonths,
  type CommandContext,
} from '@prisms/ui';

import { DayJournalPanel } from '../components/DayJournal';
import { NoteSwap } from '../components/NoteSwap';
import { isJournalFilterActive, toDayLogFilter, useJournalFilter } from '../journal-filter';

const MONTHS_SHOWN = 12;
const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Month keys 'YYYY-MM', newest first, from `fromMonth` back `count` months. */
function monthsBack(fromMonth: string, count: number): string[] {
  let y = Number(fromMonth.slice(0, 4));
  let m = Number(fromMonth.slice(5, 7));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (--m === 0) { m = 12; y--; }
  }
  return out;
}

/** 'YYYY-MM' → 'July 2026' (parsed as UTC so the label never drifts a day). */
function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** 'YYYY-MM-DD' → 'Sun 5'. */
function dayLabel(date: string): string {
  return `${DAY_LABEL[new Date(`${date}T00:00:00Z`).getUTCDay()]} ${Number(date.slice(8))}`;
}

/** First non-empty line, stripped of leading markdown markers, for the day preview. */
function noteTitle(content: string): string {
  const line = content.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const clean = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '')
    .replace(/^>\s+/, '');
  return truncatePlain(clean, 42);
}

type View = 'date' | 'tag';
const UNTAGGED = '\u0000untagged';

/** A day's row in either list: date, title, and the note's tags as quiet chips. */
function DayRow({ entry, selected, onSelect }: { entry: JournalEntry; selected: boolean; onSelect: () => void }) {
  return (
    <button
      className={`px-jn-d${selected ? ' px-jn-d--sel' : ''}`}
      data-testid={`journal-day-${entry.entry_date}`}
      aria-current={selected}
      onClick={onSelect}
    >
      <span className="px-jn-d-date">{dayLabel(entry.entry_date)}</span>
      {/* a named note shows its NAME; an untitled one still shows its first line,
          which is more use than "Note · <date>". */}
      <span className="px-jn-d-title">
        {entry.title.trim() || noteTitle(entry.content) || journalTitleOf(entry.title, entry.entry_date)}
      </span>
      {entry.tags.length > 0 && (
        <span className="px-jn-d-tags" data-testid={`journal-day-tags-${entry.entry_date}`}>
          {entry.tags.map((t) => (
            <span key={t} className="px-jn-d-tag">#{t}</span>
          ))}
        </span>
      )}
    </button>
  );
}

export function Journal({ ctx }: { ctx: CommandContext }) {
  const [now] = useState<Instant>(() => asEpochMillis(Date.now()));
  const fc = useFactContext();
  const today = fc.today(now);
  const curMonth = today.slice(0, 7);

  const monthList = useMemo(() => monthsBack(curMonth, MONTHS_SHOWN), [curMonth]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([curMonth]));
  const [selectedDay, setSelectedDay] = useState<string>(today);
  const [view, setView] = useState<View>('date');
  const { filter, patch, clear } = useJournalFilter();

  // By date holds only the expanded months (lazy); by tag needs them all.
  const heldMonths = useMemo(() => (view === 'tag' ? monthList : [...expanded]), [view, monthList, expanded]);
  const { entries } = useJournalMonths(heldMonths);

  // Every day's generated log, for the project / vision filter and its options.
  const dayLogs = useDayLogsByDate();
  const { project_id, vision_id } = toDayLogFilter(filter);
  const dayFilterOn = project_id !== null || vision_id !== null;
  const refs = useMemo(() => {
    const projects = new Map<string, DayLogRef>();
    const visions = new Map<string, DayLogRef>();
    for (const log of dayLogs.values()) {
      const r = dayLogRefs(log);
      for (const p of r.projects) projects.set(p.id, p);
      for (const v of r.visions) visions.set(v.id, v);
    }
    // keep a chosen project/vision selectable even if no day mentions it any more
    if (filter.project) projects.set(filter.project.id, filter.project);
    if (filter.vision) visions.set(filter.vision.id, filter.vision);
    const byTitle = (a: DayLogRef, b: DayLogRef) => a.title.localeCompare(b.title);
    return { projects: [...projects.values()].sort(byTitle), visions: [...visions.values()].sort(byTitle) };
  }, [dayLogs, filter.project, filter.vision]);

  // Notes that exist (an empty note is not a note), before any filter.
  const notes = useMemo(() => entries.filter((e) => !isJournalContentEmpty(e.content)), [entries]);

  // Tags available to pick = tags on the notes currently held, with counts.
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of notes) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    if (filter.tag && !counts.has(filter.tag)) counts.set(filter.tag, 0);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [notes, filter.tag]);

  const visible = useMemo(
    () =>
      notes.filter((n) => {
        if (filter.tag !== null && !n.tags.includes(filter.tag)) return false;
        if (dayFilterOn && filterDayLog(dayLogs.get(n.entry_date), { project_id, vision_id }) === null) return false;
        return true;
      }),
    [notes, filter.tag, dayFilterOn, dayLogs, project_id, vision_id],
  );

  const daysByMonth = useMemo(() => {
    const m = new Map<string, JournalEntry[]>();
    for (const e of visible) {
      const k = e.entry_date.slice(0, 7);
      let list = m.get(k);
      if (!list) { list = []; m.set(k, list); }
      list.push(e);
    }
    for (const list of m.values()) list.sort((a, b) => (a.entry_date < b.entry_date ? 1 : -1)); // newest day first
    return m;
  }, [visible]);

  // By tag: one group per tag, A–Z, then the untagged. A note with two tags is
  // listed under both — that is what "sort by the tag it has" means for a set.
  const tagGroups = useMemo(() => {
    const groups = new Map<string, JournalEntry[]>();
    for (const n of visible) {
      for (const t of n.tags.length > 0 ? n.tags : [UNTAGGED]) {
        let list = groups.get(t);
        if (!list) { list = []; groups.set(t, list); }
        list.push(n);
      }
    }
    for (const list of groups.values()) list.sort((a, b) => (a.entry_date < b.entry_date ? 1 : -1));
    return [...groups.entries()].sort(([a], [b]) => (a === UNTAGGED ? 1 : b === UNTAGGED ? -1 : a.localeCompare(b)));
  }, [visible]);

  function toggle(month: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(month)) next.delete(month);
      else next.add(month);
      return next;
    });
  }

  const filterOn = isJournalFilterActive(filter);
  const pickRef = (list: DayLogRef[], id: string): DayLogRef | null => list.find((r) => r.id === id) ?? null;

  return (
    <section className="px-journal-view">
      <div className="px-page-head">
        <h1>Journal</h1>
        <span className="px-page-sub">one note per day · markdown</span>
      </div>

      <div className="px-jn-bar" data-testid="journal-bar" role="toolbar" aria-label="Journal view and filters">
        <div className="px-seg" role="group" aria-label="Group notes by">
          <button
            className={`px-seg-btn${view === 'date' ? ' px-seg-btn--on' : ''}`}
            data-testid="journal-view-date"
            aria-pressed={view === 'date'}
            onClick={() => setView('date')}
          >
            By date
          </button>
          <button
            className={`px-seg-btn${view === 'tag' ? ' px-seg-btn--on' : ''}`}
            data-testid="journal-view-tag"
            aria-pressed={view === 'tag'}
            onClick={() => setView('tag')}
          >
            By tag
          </button>
        </div>
        <select
          className="px-select px-jn-sel"
          data-testid="journal-filter-tag"
          aria-label="filter by tag"
          value={filter.tag ?? ''}
          onChange={(e) => patch({ tag: e.target.value || null })}
        >
          <option value="">All tags</option>
          {tagCounts.map(([t, n]) => (
            <option key={t} value={t}>#{t} ({n})</option>
          ))}
        </select>
        <select
          className="px-select px-jn-sel"
          data-testid="journal-filter-vision"
          aria-label="filter by vision"
          value={filter.vision?.id ?? ''}
          onChange={(e) => patch({ vision: pickRef(refs.visions, e.target.value) })}
        >
          <option value="">All visions</option>
          {refs.visions.map((v) => (
            <option key={v.id} value={v.id}>{v.title || '(untitled)'}</option>
          ))}
        </select>
        <select
          className="px-select px-jn-sel"
          data-testid="journal-filter-project"
          aria-label="filter by project"
          value={filter.project?.id ?? ''}
          onChange={(e) => patch({ project: pickRef(refs.projects, e.target.value) })}
        >
          <option value="">All projects</option>
          {refs.projects.map((p) => (
            <option key={p.id} value={p.id}>{p.title || '(untitled)'}</option>
          ))}
        </select>
        {filterOn && (
          <button className="px-btn" data-testid="journal-filter-clear" onClick={clear}>
            Clear filters
          </button>
        )}
      </div>

      <div className="px-jn-cols">
        <div className="px-jn-months" data-testid="journal-months">
          {view === 'tag' ? (
            <div data-testid="journal-tag-groups">
              <p className="px-muted px-jn-empty">Notes from the last {MONTHS_SHOWN} months.</p>
              {tagGroups.length === 0 && (
                <p className="px-muted px-jn-empty" data-testid="journal-empty">
                  {filterOn ? 'No notes match these filters.' : 'No notes yet.'}
                </p>
              )}
              {tagGroups.map(([tag, list]) => (
                <div key={tag} className="px-jn-m" data-testid={`journal-group-${tag === UNTAGGED ? 'untagged' : tag}`}>
                  <div className="px-jn-mh px-jn-mh--static">
                    <span className="px-jn-mh-label">{tag === UNTAGGED ? 'Untagged' : `#${tag}`}</span>
                    <span className="px-tag px-tag--grey">{list.length} note{list.length === 1 ? '' : 's'}</span>
                  </div>
                  <div className="px-jn-days">
                    {list.map((e) => (
                      <DayRow key={e.entry_date} entry={e} selected={selectedDay === e.entry_date} onSelect={() => setSelectedDay(e.entry_date)} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            monthList.map((month) => {
              const isOpen = expanded.has(month);
              const days = daysByMonth.get(month) ?? [];
              return (
                <div key={month} className="px-jn-m">
                  <button
                    className="px-jn-mh"
                    data-testid={`journal-month-${month}`}
                    aria-expanded={isOpen}
                    onClick={() => toggle(month)}
                  >
                    <Ic name={isOpen ? 'chevd' : 'chevr'} />
                    <span className="px-jn-mh-label">{monthLabel(month)}</span>
                    {isOpen && <span className="px-tag px-tag--grey">{days.length} note{days.length === 1 ? '' : 's'}</span>}
                  </button>
                  {isOpen && (
                    <div className="px-jn-days">
                      {days.length === 0 && (
                        <p className="px-muted px-jn-empty">{filterOn ? 'No notes match these filters.' : 'No notes this month.'}</p>
                      )}
                      {days.map((e) => (
                        <DayRow key={e.entry_date} entry={e} selected={selectedDay === e.entry_date} onSelect={() => setSelectedDay(e.entry_date)} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="px-jn-editor">
          {/* key by day so the editor re-initializes per day (J4/D3); NoteSwap
              holds the outgoing day on screen long enough to fade it out. */}
          <NoteSwap swapKey={selectedDay}>
            <DayJournalPanel key={selectedDay} date={selectedDay} ctx={ctx} />
          </NoteSwap>
        </div>
      </div>
    </section>
  );
}