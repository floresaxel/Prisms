/**
 * Tasks (web redesign W4/D6) — one screen for every task, absorbing the old
 * Inbox. A capture bar mints a parentless `activity`; two grouping tabs follow:
 *   • By project — the Inbox group FIRST (promote-to-parent), then one group per
 *     project walking the tree, each task row carrying its checklist substeps
 *     (W3 task_steps: expand, add-on-Enter, toggle, inline rename).
 *   • By status — Available (priority order) / Blocked / Inbox / Done today.
 *
 * Load-bearing testids preserved from the old Inbox: activity-title, activity-add,
 * inbox (with <li> rows), promote-target-*, promote-* (D8).
 */
import { useState, type FormEvent } from 'react';

import { asEpochMillis, initialSortOrder, sortOrderBetween, type Instant, type Node, type TaskStatus, type TaskStep } from '@prisms/core';
import {
  Ic,
  useActivityInbox,
  useBlockedTasks,
  useCommands,
  useDoneToday,
  useIsHydrated,
  useMyDayAvailable,
  usePromoteTargets,
  useTaskStepsByTask,
  useTasksByProject,
  type PrismsCommands,
  type CommandContext,
  type MyDayItem,
  type PromoteTarget,
} from '@prisms/ui';

import { formatMinutes, projectTone } from '../format';

export function Tasks({ ctx }: { ctx: CommandContext }) {
  // Status here is minute-stable; a single mount snapshot is enough (the reads
  // still re-run reactively when rows change).
  const [now] = useState<Instant>(() => asEpochMillis(Date.now()));
  const commands = useCommands(ctx);
  const hydrated = useIsHydrated();
  const [tab, setTab] = useState<'byproject' | 'bystatus'>('byproject');
  const [title, setTitle] = useState('');

  const activities = useActivityInbox();
  const targets = usePromoteTargets();
  const groups = useTasksByProject(now);
  const stepsByTask = useTaskStepsByTask();
  const available = useMyDayAvailable(now);
  const blocked = useBlockedTasks(now);
  const doneToday = useDoneToday(now);

  async function capture(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (t === '') return;
    const last = activities.at(-1)?.sort_order ?? null;
    const sortOrder = last === null ? initialSortOrder() : sortOrderBetween(last, null);
    await commands.createActivity({ title: t, sortOrder });
    setTitle('');
  }

  return (
    <section>
      <div className="px-page-head">
        <h1>Tasks</h1>
        <span className="px-page-sub">every task in one list — captures wait in Inbox until promoted</span>
      </div>

      <form className="px-capture" onSubmit={capture}>
        <input
          data-testid="activity-title"
          placeholder="Capture anything… Enter to add. No parent needed — it waits in Inbox."
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button className="px-btn px-btn--primary" type="submit" data-testid="activity-add">Capture</button>
      </form>

      <div className="px-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'byproject'} data-testid="tasks-tab-byproject" className={`px-tab${tab === 'byproject' ? ' px-tab--on' : ''}`} onClick={() => setTab('byproject')}>
          <Ic name="layers" /> By project
        </button>
        <button role="tab" aria-selected={tab === 'bystatus'} data-testid="tasks-tab-bystatus" className={`px-tab${tab === 'bystatus' ? ' px-tab--on' : ''}`} onClick={() => setTab('bystatus')}>
          <Ic name="cols" /> By status
        </button>
      </div>

      {tab === 'byproject' ? (
        <div style={{ maxWidth: 900 }}>
          <div className="px-sec">Inbox <span className="px-sec-cnt">· {activities.length} — no parent yet</span><span className="px-sec-ln" /></div>
          <ul className="px-rows" data-testid="inbox">
            {activities.length === 0 && <li className="px-trow px-muted">{hydrated ? 'Inbox is empty.' : 'Loading…'}</li>}
            {activities.map((a) => (
              <InboxRow key={a.id} activity={a} targets={targets} commands={commands} />
            ))}
          </ul>

          {groups.map((g) => (
            <div key={g.project.id}>
              <div className="px-sec">
                <span className={`px-pdot px-pdot--${projectTone(g.project.id)}`} />
                {g.project.title} <span className="px-sec-cnt">· {g.tasks.length}</span><span className="px-sec-ln" />
              </div>
              <ul className="px-rows" data-testid={`project-group-${g.project.id}`}>
                {g.tasks.map((t) => (
                  <TaskRow key={t.task.id} task={t.task} status={t.status} blockedBy={t.blockedBy} steps={stepsByTask.get(t.task.id) ?? []} commands={commands} />
                ))}
              </ul>
            </div>
          ))}
          <p className="px-expl">
            Substeps are lightweight checklist children — add one with <b>Enter</b>, rename it with the pencil, check it off in
            place. Groups mirror the tree; captures stay in <b>Inbox</b> until you promote them.
          </p>
        </div>
      ) : (
        <div style={{ maxWidth: 900 }}>
          <div className="px-sec">Available <span className="px-sec-cnt">· {available.length} — priority order</span><span className="px-sec-ln" /></div>
          <ul className="px-rows" data-testid="status-available">
            {available.length === 0 && <li className="px-trow px-muted">Nothing available.</li>}
            {available.map((it) => (
              <AvailableStatusRow key={it.task.id} item={it} onCheck={() => void commands.checkOff(it.task.id)} />
            ))}
          </ul>

          {blocked.length > 0 && (
            <>
              <div className="px-sec" style={{ color: 'var(--px-red)' }}>Blocked <span className="px-sec-cnt">· {blocked.length}</span><span className="px-sec-ln" /></div>
              <ul className="px-rows px-rows--muted" data-testid="status-blocked">
                {blocked.map((b) => (
                  <li className="px-trow" key={b.task.id}>
                    <span className="px-ckb" style={{ opacity: 0.4 }}><Ic name="check" /></span>
                    <div className="px-t-main"><div className="px-t-title" style={{ color: 'var(--px-text-dim)' }}>{b.task.title}</div></div>
                    <span className="px-tag px-tag--red"><Ic name="alert" />{b.blockedBy[0] ?? 'blocked'}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="px-sec">Inbox <span className="px-sec-cnt">· {activities.length}</span><span className="px-sec-ln" /></div>
          <ul className="px-rows" data-testid="status-inbox">
            {activities.length === 0 && <li className="px-trow px-muted">Inbox is empty.</li>}
            {activities.map((a) => (
              <li className="px-trow" key={a.id}><div className="px-t-main"><div className="px-t-title">{a.title}</div></div></li>
            ))}
          </ul>

          {doneToday.length > 0 && (
            <>
              <div className="px-sec" style={{ color: 'var(--px-green)' }}>Done today <span className="px-sec-cnt">· {doneToday.length}</span><span className="px-sec-ln" /></div>
              <ul className="px-rows px-rows--muted" data-testid="status-done">
                {doneToday.map((d) => (
                  <li className="px-trow px-trow--done" key={d.task.id}>
                    <span className="px-ckb px-ckb--done"><Ic name="check" /></span>
                    <div className="px-t-main"><div className="px-t-title">{d.task.title}</div></div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function InboxRow({ activity, targets, commands }: { activity: Node; targets: PromoteTarget[]; commands: PrismsCommands }) {
  const [parentId, setParentId] = useState('');
  const selected = parentId || targets[0]?.id || '';
  return (
    <li className="px-trow">
      <div className="px-t-main"><div className="px-t-title">{activity.title}</div></div>
      <span className="px-promote">
        <select
          data-testid={`promote-target-${activity.id}`}
          value={selected}
          onChange={(e) => setParentId(e.target.value)}
          disabled={targets.length === 0}
        >
          {targets.length === 0 && <option value="">No project to promote into</option>}
          {targets.map((t) => (
            <option key={t.id} value={t.id}>{t.title} ({t.type})</option>
          ))}
        </select>
        <button
          className="px-btn px-btn--sm px-btn--primary"
          data-testid={`promote-${activity.id}`}
          disabled={selected === ''}
          onClick={() => void commands.promoteActivity(activity.id, { parentId: selected })}
        >
          Promote
        </button>
      </span>
      <button className="px-btn px-btn--sm px-btn--danger" aria-label="delete" onClick={() => void commands.softDelete(activity.id)}>×</button>
    </li>
  );
}

function AvailableStatusRow({ item, onCheck }: { item: MyDayItem; onCheck: () => void }) {
  return (
    <li className="px-trow">
      <button className="px-ckb" data-testid={`task-check-${item.task.id}`} aria-label="check off" onClick={onCheck}><Ic name="check" /></button>
      <div className="px-t-main">
        <div className="px-t-title">{item.task.title}</div>
        <div className="px-t-meta">
          {item.projectTitle && <span className="px-proj"><span className={`px-pdot px-pdot--${projectTone(item.projectId)}`} />{item.projectTitle}</span>}
          {item.priority !== null && <span className="px-prio">prio {item.priority.toFixed(1)}</span>}
        </div>
      </div>
    </li>
  );
}

function TaskRow({ task, status, blockedBy, steps, commands }: { task: Node; status: TaskStatus; blockedBy: string[]; steps: TaskStep[]; commands: PrismsCommands }) {
  const [open, setOpen] = useState(false);
  const isBlocked = status === 'blocked';
  const doneCount = steps.filter((s) => s.done).length;
  const stepsLabel = steps.length === 0 ? '+ steps' : doneCount > 0 ? `${doneCount}/${steps.length} steps` : `${steps.length} steps`;
  return (
    <>
      <li className="px-trow" data-testid={`task-row-${task.id}`}>
        <button className="px-ckb" data-testid={`task-check-${task.id}`} aria-label="check off" disabled={isBlocked} onClick={() => void commands.checkOff(task.id)}><Ic name="check" /></button>
        <div className="px-t-main">
          <div className="px-t-title" style={isBlocked ? { color: 'var(--px-text-dim)' } : undefined}>{task.title}</div>
          <div className="px-t-meta">
            {task.estimate_minutes != null && <span>est {formatMinutes(task.estimate_minutes)}</span>}
            {task.due_date && <span>due {task.due_date.slice(5)}</span>}
          </div>
        </div>
        {isBlocked ? (
          <span className="px-tag px-tag--red"><Ic name="alert" />{blockedBy[0] ?? 'blocked'}</span>
        ) : (
          <button className="px-tag px-tag--grey px-steps-tg" data-testid={`steps-toggle-${task.id}`} title="Show substeps" onClick={() => setOpen((o) => !o)}>{stepsLabel}</button>
        )}
      </li>
      {open && !isBlocked && (
        <li className="px-sub-wrap">
          <SubstepPanel taskId={task.id} steps={steps} commands={commands} />
        </li>
      )}
    </>
  );
}

function SubstepPanel({ taskId, steps, commands }: { taskId: string; steps: TaskStep[]; commands: PrismsCommands }) {
  const [draft, setDraft] = useState('');
  async function add() {
    const t = draft.trim();
    if (t === '') return;
    const last = steps.at(-1)?.sort_order ?? null;
    const sortOrder = last === null ? initialSortOrder() : sortOrderBetween(last, null);
    await commands.addStep({ taskId, title: t, sortOrder });
    setDraft('');
  }
  return (
    <div className="px-substeps" data-testid={`substeps-${taskId}`}>
      {steps.map((s) => (
        <SubstepRow key={s.id} step={s} commands={commands} />
      ))}
      <div className="px-addstep">
        <input
          data-testid={`step-add-${taskId}`}
          placeholder="Add a step — Enter to save"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
        />
      </div>
    </div>
  );
}

function SubstepRow({ step, commands }: { step: TaskStep; commands: PrismsCommands }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(step.title);
  async function commit() {
    setEditing(false);
    const t = draft.trim();
    if (t !== '' && t !== step.title) await commands.renameStep(step.id, t);
    else setDraft(step.title);
  }
  return (
    <div className={`px-sstep${step.done ? ' px-sstep--done' : ''}`}>
      <button
        className={`px-ss-ck${step.done ? ' px-ss-ck--done' : ''}`}
        data-testid={`step-toggle-${step.id}`}
        aria-label="toggle step"
        onClick={() => void commands.toggleStep(step.id, !step.done)}
      >
        <Ic name="check" />
      </button>
      {editing ? (
        <input
          className="px-sstep-input"
          data-testid={`step-rename-input-${step.id}`}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit();
            } else if (e.key === 'Escape') {
              setDraft(step.title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="px-sstep-txt">{step.title}</span>
      )}
      <button className="px-sstep-ed" data-testid={`step-rename-${step.id}`} title="Rename step" onClick={() => { setDraft(step.title); setEditing(true); }}>
        <Ic name="pen" />
      </button>
    </div>
  );
}
