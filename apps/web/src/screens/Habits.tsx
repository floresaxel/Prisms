/**
 * Habits & skills (§1.2, §7.2): create/edit/delete recurring practices tied to
 * a vision, check them off, and track streaks, the daily-target ring, and (for
 * skills) practice hours + levels + mastery progress. Every value is computed
 * live in core from local facts — the ring fills while a skill task's timer
 * runs — with the server aggregate's `computed_at` shown as a freshness label
 * over the live value (§7.2: live incremental, canonical overwrite).
 */
import { useEffect, useMemo, useState } from 'react';

import { asEpochMillis, type Instant } from '@prisms/core';
import { List, ListItem, Modal, useCommands, useFactContext, useHabits, useNodeTree, type CommandContext, type HabitView } from '@prisms/ui';

import { formatMinutes } from '../format';

type StreakMode = 'perfect_planned' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
const STREAK_MODES: StreakMode[] = ['daily', 'perfect_planned', 'weekly', 'monthly', 'quarterly', 'yearly'];

/** Occurrence pattern aligned with the chosen streak period. */
function rruleFor(mode: StreakMode): string {
  switch (mode) {
    case 'weekly': return 'FREQ=WEEKLY';
    case 'monthly': return 'FREQ=MONTHLY';
    case 'quarterly': return 'FREQ=MONTHLY;INTERVAL=3';
    case 'yearly': return 'FREQ=YEARLY';
    default: return 'FREQ=DAILY';
  }
}

/** "1, 10, 100" → [1, 10, 100] (positive, ascending-as-typed). */
function parseLevels(text: string): number[] {
  return text.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
}

function Ring({ view }: { view: HabitView }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const fill = view.ringFill ?? 0;
  return (
    <div className="px-ring" data-testid={`ring-${view.habit.id}`} data-fill={fill.toFixed(3)} title={`${view.todayMinutes.toFixed(0)}m today`}>
      <svg width="64" height="64" viewBox="0 0 64 64">
        <circle cx="32" cy="32" r={r} className="px-ring-track" />
        <circle cx="32" cy="32" r={r} className="px-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - fill)} transform="rotate(-90 32 32)" />
      </svg>
      <span className="px-ring-label">{view.dailyTargetMinutes ? `${Math.round(fill * 100)}%` : '—'}</span>
    </div>
  );
}

function PracticeLine({ view }: { view: HabitView }) {
  const { practice, habit } = view;
  const hasLevels = habit.level_thresholds_hours.length > 0;
  const mastery = habit.mastery_target_hours;
  // A "skill" is a habit that accrues practice: it has a mastery target,
  // levels, or simply logged time. Plain check-off habits show no hours.
  if (!hasLevels && mastery == null && practice.minutes <= 0) return null;
  return (
    <span data-testid={`practice-${habit.id}`}>
      {' · '}{practice.hours.toFixed(1)}h
      {hasLevels && ` · L${practice.level}${practice.nextThresholdHours != null ? ` (next ${practice.nextThresholdHours}h)` : ' (max)'}`}
      {mastery != null && ` · ${Math.min(100, Math.round((practice.hours / mastery) * 100))}% to ${mastery}h`}
    </span>
  );
}

interface EditState {
  id: string;
  title: string;
  dailyTarget: string;
  mastery: string;
  levels: string;
}

export function Habits({ ctx }: { ctx: CommandContext }) {
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 1000);
    return () => clearInterval(t);
  }, []);

  const fact = useFactContext();
  const tree = useNodeTree();
  const habits = useHabits(now);
  const commands = useCommands(ctx);

  const visions = useMemo(
    () => [...tree.byId.values()].filter((n) => n.node_type === 'vision').sort((a, b) => (a.sort_order < b.sort_order ? -1 : 1)),
    [tree],
  );

  const [title, setTitle] = useState('');
  const [visionId, setVisionId] = useState('');
  const [mode, setMode] = useState<StreakMode>('daily');
  const [dailyTarget, setDailyTarget] = useState('');
  const [mastery, setMastery] = useState('');
  const [levels, setLevels] = useState('');
  const [edit, setEdit] = useState<EditState | null>(null);

  const selectedVision = visionId || visions[0]?.id || '';

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (title.trim() === '' || selectedVision === '') return;
    await commands.createHabit({
      visionId: selectedVision,
      title: title.trim(),
      rrule: rruleFor(mode),
      streakMode: mode,
      dailyTargetMinutes: dailyTarget === '' ? null : Number(dailyTarget),
      masteryTargetHours: mastery === '' ? null : Number(mastery),
      levelThresholdsHours: parseLevels(levels),
    });
    setTitle('');
    setDailyTarget('');
    setMastery('');
    setLevels('');
  }

  function openEdit(view: HabitView) {
    setEdit({
      id: view.habit.id,
      title: view.habit.title,
      dailyTarget: view.habit.daily_target_minutes?.toString() ?? '',
      mastery: view.habit.mastery_target_hours?.toString() ?? '',
      levels: view.habit.level_thresholds_hours.join(', '),
    });
  }

  async function saveEdit() {
    if (!edit || edit.title.trim() === '') return;
    await commands.updateHabit(edit.id, {
      title: edit.title.trim(),
      dailyTargetMinutes: edit.dailyTarget === '' ? null : Number(edit.dailyTarget),
      masteryTargetHours: edit.mastery === '' ? null : Number(edit.mastery),
      levelThresholdsHours: parseLevels(edit.levels),
    });
    setEdit(null);
  }

  return (
    <section>
      <h1>Habits &amp; skills</h1>

      <form onSubmit={create} className="px-habit-form" data-testid="habit-form">
        <input className="px-input" placeholder="New habit…" value={title} data-testid="habit-title" onChange={(e) => setTitle(e.target.value)} />
        <select className="px-select" value={selectedVision} data-testid="habit-vision" onChange={(e) => setVisionId(e.target.value)} disabled={visions.length === 0}>
          {visions.length === 0 && <option value="">Create a vision first</option>}
          {visions.map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
        </select>
        <select className="px-select" value={mode} data-testid="habit-mode" onChange={(e) => setMode(e.target.value as StreakMode)}>
          {STREAK_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input className="px-input" placeholder="daily target (min)" value={dailyTarget} data-testid="habit-target" onChange={(e) => setDailyTarget(e.target.value.replace(/[^0-9]/g, ''))} style={{ width: 130 }} />
        <input className="px-input" placeholder="mastery (h)" value={mastery} data-testid="habit-mastery" onChange={(e) => setMastery(e.target.value.replace(/[^0-9]/g, ''))} style={{ width: 110 }} />
        <input className="px-input" placeholder="levels e.g. 1,10,100" value={levels} data-testid="habit-levels" onChange={(e) => setLevels(e.target.value)} style={{ width: 150 }} />
        <button className="px-btn px-btn--primary" type="submit" data-testid="habit-add" disabled={selectedVision === ''}>Add</button>
      </form>

      <div data-testid="habits" style={{ marginTop: 18 }}>
        <List empty="No habits yet.">
          {habits.map((view) => (
            <ListItem
              key={view.habit.id}
              leading={<Ring view={view} />}
              trailing={
                <>
                  <button
                    className="px-btn px-btn--primary"
                    data-testid={`habit-check-${view.habit.id}`}
                    disabled={view.doneToday}
                    onClick={() => void commands.checkOffHabit({ habitId: view.habit.id, occurrenceDate: fact.today(now) })}
                  >
                    {view.doneToday ? 'Done ✓' : 'Check off'}
                  </button>
                  <button className="px-btn" data-testid={`habit-edit-${view.habit.id}`} onClick={() => openEdit(view)}>Edit</button>
                  <button className="px-btn px-btn--danger" aria-label="delete" data-testid={`habit-delete-${view.habit.id}`} onClick={() => void commands.deleteHabit(view.habit.id)}>×</button>
                </>
              }
            >
              <strong>{view.habit.title}</strong>
              <div className="px-muted" data-testid={`habit-stats-${view.habit.id}`}>
                <span data-testid={`streak-${view.habit.id}`}>🔥 {view.streak.current} ({view.habit.streak_mode}, best {view.streak.longest})</span>
                {view.dailyTargetMinutes != null && <span> · {formatMinutes(view.todayMinutes)}/{view.dailyTargetMinutes}m today</span>}
                <PracticeLine view={view} />
                <span> · {view.serverComputedAt ? `synced ${new Date(view.serverComputedAt).toLocaleDateString()}` : 'live'}</span>
              </div>
            </ListItem>
          ))}
        </List>
      </div>

      <Modal
        open={edit !== null}
        title="Edit habit"
        onClose={() => setEdit(null)}
        actions={
          <>
            <button className="px-btn" onClick={() => setEdit(null)}>Cancel</button>
            <button className="px-btn px-btn--primary" data-testid="edit-save" onClick={() => void saveEdit()}>Save</button>
          </>
        }
      >
        {edit && (
          <>
            <label className="px-field">Title<input className="px-input" value={edit.title} data-testid="edit-title" onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
            <label className="px-field">Daily target (min)<input className="px-input" value={edit.dailyTarget} data-testid="edit-target" onChange={(e) => setEdit({ ...edit, dailyTarget: e.target.value.replace(/[^0-9]/g, '') })} /></label>
            <label className="px-field">Mastery (h)<input className="px-input" value={edit.mastery} data-testid="edit-mastery" onChange={(e) => setEdit({ ...edit, mastery: e.target.value.replace(/[^0-9]/g, '') })} /></label>
            <label className="px-field">Levels (h)<input className="px-input" value={edit.levels} data-testid="edit-levels" onChange={(e) => setEdit({ ...edit, levels: e.target.value })} /></label>
          </>
        )}
      </Modal>
    </section>
  );
}
