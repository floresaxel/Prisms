/**
 * The day log with its project / vision filter. Composes the inert footer with a
 * small control bar, so the footer itself can stay a pure picture of what it is
 * handed (see `DayLogFooter`).
 *
 * The filter is the shared journal one (`useJournalFilter`), so it follows you
 * between days and matches what the Journal screen's list is narrowed to. The
 * `.md` export is NOT filtered — it always writes the whole day; this narrows the
 * view only.
 *
 * The options are the projects and visions the OPEN day actually touches, plus
 * the current choice even when this day does not mention it — otherwise stepping
 * to a day without that project would make the select show a blank it cannot name.
 */
import { useMemo } from 'react';

import { dayLogRefs, filterDayLog, isDayLogEmpty, type DayLogEntries, type DayLogRef } from '@prisms/core';

import { toDayLogFilter, useJournalFilter } from '../journal-filter';
import { DayLogFooter } from './DayLogFooter';

function withCurrent(options: DayLogRef[], current: DayLogRef | null): DayLogRef[] {
  return current && !options.some((o) => o.id === current.id) ? [...options, current] : options;
}

export function DayLogSection({
  entries,
  timezone,
  date,
  dayResetHour,
}: {
  entries: DayLogEntries | null;
  timezone: string;
  /** The journal day shown; the Clocked bar spans it. */
  date?: string;
  dayResetHour?: number;
}) {
  const { filter, patch } = useJournalFilter();
  const { project_id, vision_id } = toDayLogFilter(filter);
  const active = project_id !== null || vision_id !== null;

  const refs = useMemo(() => dayLogRefs(entries), [entries]);
  const narrowed = useMemo(
    () => filterDayLog(entries, { project_id, vision_id }),
    [entries, project_id, vision_id],
  );

  // Nothing to log and nothing to filter: render nothing, as the footer always did.
  if (!active && (!entries || isDayLogEmpty(entries))) return null;

  const projects = withCurrent(refs.projects, filter.project);
  const visions = withCurrent(refs.visions, filter.vision);
  const pick = (list: DayLogRef[], id: string): DayLogRef | null => list.find((r) => r.id === id) ?? null;

  return (
    <>
      {(projects.length > 0 || visions.length > 0 || active) && (
        <div className="px-daylog-filter" data-testid="daylog-filter" role="group" aria-label="Filter the day log">
          <span className="px-daylog-filter-lbl">Show</span>
          <select
            className="px-select px-daylog-sel"
            data-testid="daylog-filter-vision"
            aria-label="filter by vision"
            value={filter.vision?.id ?? ''}
            onChange={(e) => patch({ vision: pick(visions, e.target.value) })}
          >
            <option value="">All visions</option>
            {visions.map((v) => (
              <option key={v.id} value={v.id}>{v.title || '(untitled)'}</option>
            ))}
          </select>
          <select
            className="px-select px-daylog-sel"
            data-testid="daylog-filter-project"
            aria-label="filter by project"
            value={filter.project?.id ?? ''}
            onChange={(e) => patch({ project: pick(projects, e.target.value) })}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.title || '(untitled)'}</option>
            ))}
          </select>
          {active && (
            <button
              type="button"
              className="px-btn px-daylog-clear"
              data-testid="daylog-filter-clear"
              onClick={() => patch({ project: null, vision: null })}
            >
              Clear
            </button>
          )}
        </div>
      )}
      {narrowed ? (
        <DayLogFooter entries={narrowed} timezone={timezone} date={date} dayResetHour={dayResetHour} />
      ) : (
        // Filtered down to nothing (or the day holds nothing for this choice).
        active && (
          <p className="px-muted px-daylog-none" data-testid="daylog-filter-empty">
            Nothing on this day for {[filter.vision?.title, filter.project?.title].filter(Boolean).join(' › ') || 'that filter'}.
          </p>
        )
      )}
    </>
  );
}
