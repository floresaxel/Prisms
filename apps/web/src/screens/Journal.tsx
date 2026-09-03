/**
 * Journal (web redesign W6) — a standalone month browser around the existing
 * day-note editor. The month list is LAZY: a month subscribes its rows only
 * when expanded (the ref-counted `useJournalMonths` manager, shared with the
 * Agenda's day panel), so years of journaling never weigh down sync — collapsed
 * months show no note count precisely because they were never pulled. The
 * current month opens expanded; picking any day loads it in the `DayJournalPanel`
 * editor. "Download archive" is server-sourced (every month, even ones never
 * synced to this device) — the same bytes as Settings › Data & portability.
 */
import { useMemo, useState } from 'react';

import { asEpochMillis, type Instant, type JournalEntry } from '@prisms/core';
import { Ic, isJournalContentEmpty, journalTitleOf, truncatePlain, useFactContext, useJournalMonths, type CommandContext } from '@prisms/ui';

import { DayJournalPanel } from '../components/DayJournal';
import { NoteSwap } from '../components/NoteSwap';
import { downloadJournalArchive } from '../portability';

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

export function Journal({ ctx }: { ctx: CommandContext }) {
  const [now] = useState<Instant>(() => asEpochMillis(Date.now()));
  const fc = useFactContext();
  const today = fc.today(now);
  const curMonth = today.slice(0, 7);

  const monthList = useMemo(() => monthsBack(curMonth, MONTHS_SHOWN), [curMonth]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([curMonth]));
  const [selectedDay, setSelectedDay] = useState<string>(today);
  const [busy, setBusy] = useState(false);

  // Only expanded months are held → their rows sync lazily; the rest stay remote.
  const { entries } = useJournalMonths([...expanded]);
  const daysByMonth = useMemo(() => {
    const m = new Map<string, JournalEntry[]>();
    for (const e of entries) {
      // an empty note is not a note — it must not appear as a day in the month
      if (isJournalContentEmpty(e.content)) continue;
      const k = e.entry_date.slice(0, 7);
      let list = m.get(k);
      if (!list) { list = []; m.set(k, list); }
      list.push(e);
    }
    for (const list of m.values()) list.sort((a, b) => (a.entry_date < b.entry_date ? 1 : -1)); // newest day first
    return m;
  }, [entries]);

  function toggle(month: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(month)) next.delete(month);
      else next.add(month);
      return next;
    });
  }

  async function onArchive() {
    setBusy(true);
    try {
      await downloadJournalArchive(fc.timezone);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="px-journal-view">
      <div className="px-page-head">
        <h1>Journal</h1>
        <span className="px-page-sub">one note per day · markdown</span>
        <div className="px-head-actions">
          <button className="px-btn" data-testid="journal-archive" disabled={busy} onClick={() => void onArchive()}>
            <Ic name="down" /> Download archive (.zip)
          </button>
        </div>
      </div>

      <div className="px-jn-cols">
        <div className="px-jn-months" data-testid="journal-months">
          {monthList.map((month) => {
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
                    {days.length === 0 && <p className="px-muted px-jn-empty">No notes this month.</p>}
                    {days.map((e) => (
                      <button
                        key={e.entry_date}
                        className={`px-jn-d${selectedDay === e.entry_date ? ' px-jn-d--sel' : ''}`}
                        data-testid={`journal-day-${e.entry_date}`}
                        aria-current={selectedDay === e.entry_date}
                        onClick={() => setSelectedDay(e.entry_date)}
                      >
                        <span className="px-jn-d-date">{dayLabel(e.entry_date)}</span>
                        {/* a named note shows its NAME; an untitled one still shows
                            its first line, which is more use than "Note · <date>". */}
                        <span className="px-jn-d-title">
                          {e.title.trim() || noteTitle(e.content) || journalTitleOf(e.title, e.entry_date)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
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
