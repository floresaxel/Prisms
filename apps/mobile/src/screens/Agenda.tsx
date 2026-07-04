/**
 * Agenda (§12.1 mobile): tap-to-place assist instead of drag — tap a to-do
 * task to see the valid time windows (core `validWindowsFor`), tap a window to
 * commit a block. Past/committed blocks list below as the schedule.
 */
import { useEffect, useMemo, useState } from 'react';

import { addDays, asEpochMillis, bucketDate, epochMillisToIso, validWindowsFor, type Instant, type Interval } from '@prisms/core';
import { useAgenda, useCommands, useIsHydrated, useJournalMonths, type CommandContext } from '@prisms/ui';

import { Btn, Card, H1, H2, Muted, Row, Screen, Skeleton, Txt } from '../ui';
import { JournalDay } from './JournalDay';

const fmt = (ms: number): string => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export function Agenda({ ctx }: { ctx: CommandContext }) {
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 60_000);
    return () => clearInterval(t);
  }, []);

  const agenda = useAgenda(now);
  const commands = useCommands(ctx);
  const hydrated = useIsHydrated();
  const [selected, setSelected] = useState<string | null>(null);
  const [journalDay, setJournalDay] = useState<string | null>(null);

  // §7.3/D3: a 7-day journal picker. useJournalMonths holds the visible day(s)'
  // month(s) (may span two), so a fresh device pulls zero journal rows until a
  // day here is viewed. A dot marks days that already have a note.
  const tz = agenda.input.timezone;
  const days = useMemo(() => {
    const base = bucketDate(now, 0, tz);
    return Array.from({ length: 7 }, (_, i) => addDays(base, i));
  }, [now, tz]);
  const months = useMemo(() => [...new Set(days.map((d) => d.slice(0, 7)))], [days]);
  const journal = useJournalMonths(months);
  const noteDates = useMemo(() => new Set(journal.entries.map((e) => e.entry_date)), [journal.entries]);

  const windows = useMemo<Interval[]>(() => {
    if (selected === null) return [];
    const task = agenda.tasksById.get(selected);
    return task ? validWindowsFor(task, agenda.input).slice(0, 8) : [];
  }, [selected, agenda]);

  async function place(task: { id: string; estimateMinutes: number }, start: number) {
    await commands.createBlock({
      taskId: task.id,
      startsAt: epochMillisToIso(asEpochMillis(start)),
      endsAt: epochMillisToIso(asEpochMillis(start + task.estimateMinutes * 60_000)),
    });
    setSelected(null);
  }

  return (
    <Screen testID="agenda">
      <H1>Agenda</H1>
      <Muted>Tap a task, then tap a highlighted window to schedule it.</Muted>

      <H2>Journal</H2>
      <Row>
        {days.map((d) => (
          <Btn
            key={d}
            title={`${d.slice(5)}${noteDates.has(d) ? ' •' : ''}`}
            testID={`journal-day-${d}`}
            variant={journalDay === d ? 'primary' : 'default'}
            onPress={() => setJournalDay(journalDay === d ? null : d)}
          />
        ))}
      </Row>
      {journalDay !== null && <JournalDay key={journalDay} date={journalDay} ctx={ctx} onClose={() => setJournalDay(null)} />}

      <H2>To-do</H2>
      {agenda.todo.length === 0 && (hydrated ? <Muted>Nothing to place.</Muted> : <Skeleton testID="todo-skeleton" rows={2} />)}
      {agenda.todo.map(({ task, schedulable }) => (
        <Card key={task.id} testID={`todo-${task.id}`}>
          <Row>
            <Txt>{task.title}</Txt>
            <Muted>{schedulable.estimateMinutes}m</Muted>
            <Btn title={selected === task.id ? 'Hide windows' : 'Place'} testID={`place-${task.id}`} onPress={() => setSelected(selected === task.id ? null : task.id)} />
          </Row>
          {selected === task.id && (
            <View_ windows={windows} onPick={(start) => void place(schedulable, start)} />
          )}
        </Card>
      ))}

      <H2>Scheduled</H2>
      {agenda.blocks.length === 0 && <Muted>No blocks yet.</Muted>}
      {agenda.blocks.map((b) => (
        <Card key={b.id} testID={`block-${b.id}`}>
          <Txt>{b.title}{b.anchored ? ' 🔒' : ''}{b.status === 'suggested' ? ' (suggested)' : ''}</Txt>
          <Muted>{fmt(b.startsAt)} – {fmt(b.endsAt)}{b.justified ? '' : ' · unjustified'}</Muted>
          {b.status === 'suggested' && (
            <Row>
              <Btn title="Accept" variant="primary" testID={`accept-${b.id}`} onPress={() => void commands.acceptSuggestion(b.id)} />
              <Btn title="Reject" variant="danger" onPress={() => void commands.rejectSuggestion(b.id)} />
            </Row>
          )}
        </Card>
      ))}
    </Screen>
  );
}

function View_({ windows, onPick }: { windows: Interval[]; onPick: (start: number) => void }) {
  if (windows.length === 0) return <Muted>No valid windows in range.</Muted>;
  return (
    <Row>
      {windows.map((w) => (
        <Btn key={w.start} title={fmt(w.start)} testID={`window-${w.start}`} onPress={() => onPick(w.start)} />
      ))}
    </Row>
  );
}
