/**
 * Tasks (web redesign W4/D6) — one screen for every task, absorbing the old
 * Inbox. A capture bar mints a parentless `activity`; two grouping tabs follow:
 *   • By project — the Inbox group FIRST (promote-to-parent), then one group per
 *     project walking the tree, each task row carrying its checklist substeps
 *     (W3 task_steps: expand, add-on-Enter, toggle, inline rename). A project's
 *     heading folds its group away; folds are remembered per device.
 *   • By status — Available (priority order) / Blocked / Inbox / Done today.
 *   • Completed — every finished task, newest first by day; the tick reopens.
 *   • Recently deleted — the last 30 days' deletions, each with Restore
 *     (`node.restore`); it holds the lazy `history` stream open while shown.
 * An Inbox row can be checked off without promoting it first: a dialog asks
 * whether to add it to a project and complete it, or complete it as an
 * unfocused task (no project behind it; Done today marks it so).
 * The capture bar can preselect a project: captures then land straight in it as
 * tasks (not in the Inbox), and the choice holds until you leave this screen.
 * Every row opens the task's details card when clicked (TaskDetail), and its
 * title renames in place when the title text itself is clicked.
 *
 * Load-bearing testids preserved from the old Inbox: activity-title, activity-add,
 * inbox (with <li> rows), promote-target-*, promote-* (D8).
 */
import { useMemo, useState, type FormEvent } from 'react';

import { usePowerSync, useStatus } from '@powersync/react';

import { asEpochMillis, initialSortOrder, sortOrderBetween, type Instant, type Node, type TaskStatus, type TaskStep } from '@prisms/core';
import {
  Ic,
  Modal,
  RECENTLY_DELETED_DAYS,
  useActivityInbox,
  useBlockedTasks,
  useCommands,
  useCompletedTasks,
  useDoneToday,
  useIsHydrated,
  useMyDayAvailable,
  useNodeTree,
  usePromoteTargets,
  useRecentlyDeleted,
  useTaskStepsByTask,
  useTasksByProject,
  type PrismsCommands,
  type StreamSubscriber,
  type CommandContext,
  type MyDayItem,
  type PromoteTarget,
} from '@prisms/ui';

import { DueDate } from '../components/DueDate';
import { InboxDelete } from '../components/InboxDelete';
import { ProjectDot } from '../components/ProjectDot';
import { RunningDot, useRunningTaskIds } from '../components/RunningDot';
import { ProjectPicker } from '../components/ProjectPicker';
import { StepsToggle, SubstepPanel } from '../components/Substeps';
import { EditableTitle, locationOf, useTaskDetail, type TaskDetailApi } from '../components/TaskDetail';
import { useTabSwap } from '../components/tabSwap';
import { UnfocusedTag } from '../components/UnfocusedTag';
import { historyNotice, useHistoryStream } from '../components/useHistoryStream';
import { useCollapsedSet } from '../components/useCollapsedSet';
import { useNewProject, type NewProjectApi } from '../components/useNewProject';
import { formatMinutes, projectTone } from '../format';
import { listLayoutClass } from '../list-layout';
import { useMeasuredWidth } from '../use-measured-width';

export function Tasks({ ctx }: { ctx: CommandContext }) {
  const [viewRef, viewWidth] = useMeasuredWidth();
  // Status here is minute-stable; a single mount snapshot is enough (the reads
  // still re-run reactively when rows change).
  const [now] = useState<Instant>(() => asEpochMillis(Date.now()));
  const commands = useCommands(ctx);
  const detail = useTaskDetail();
  const hydrated = useIsHydrated();
  const [tab, setTab] = useState<'byproject' | 'bystatus' | 'completed' | 'deleted'>('byproject');
  const [panelRef, swap] = useTabSwap();
  const pickTab = (key: typeof tab) => { if (key !== tab) swap(() => setTab(key)); };
  const [title, setTitle] = useState('');

  const activities = useActivityInbox();
  // Shown newest-first. The hook's sort_order stays oldest-first because capture()
  // appends after its tail, so the display order is derived here, from created_at.
  const inboxNewestFirst = useMemo(
    () => [...activities].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1)),
    [activities],
  );
  const targets = usePromoteTargets();
  const newProject = useNewProject(commands);
  const tree = useNodeTree();
  const groups = useTasksByProject(now);
  const stepsByTask = useTaskStepsByTask();
  const available = useMyDayAvailable(now);
  const blocked = useBlockedTasks(now);
  const doneToday = useDoneToday(now);
  // the Inbox capture whose "complete" dialog is open
  const [completing, setCompleting] = useState<Node | null>(null);

  // The project captures go into. '' = the Inbox (no project yet). Lives in this
  // screen's state, so it holds across the By project / By status tabs and resets
  // when you leave Tasks. A project that has since gone away falls back to Inbox.
  const [captureTo, setCaptureTo] = useState('');
  const captureTarget = targets.find((t) => t.id === captureTo) ?? null;
  // Which project groups are folded on By project — remembered on this device.
  const projectFolds = useCollapsedSet('prisms.tasks.collapsed-projects');
  // tasks with a live timer wear the pulsing dot in front of their title
  const running = useRunningTaskIds();

  async function capture(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (t === '') return;
    if (captureTarget) {
      // straight into the chosen project, at the end of its list
      const last = tree.childrenByParent.get(captureTarget.id)?.at(-1)?.sort_order ?? null;
      const sortOrder = last === null ? initialSortOrder() : sortOrderBetween(last, null);
      await commands.createTask({ parentId: captureTarget.id, title: t, sortOrder });
      projectFolds.expand(captureTarget.id); // a task added to a folded project must not vanish
    } else {
      const last = activities.at(-1)?.sort_order ?? null;
      const sortOrder = last === null ? initialSortOrder() : sortOrderBetween(last, null);
      await commands.createActivity({ title: t, sortOrder });
    }
    setTitle('');
  }

  return (
    <section ref={viewRef} className={`px-list${listLayoutClass(viewWidth)}`}>
      <div className="px-page-head">
        <h1>Tasks</h1>
        <span className="px-page-sub">every task in one list — captures stay Unassigned until they get a project</span>
      </div>

      <form className="px-capture" onSubmit={capture}>
        <input
          data-testid="activity-title"
          placeholder="Capture task"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <span className="px-capture-to">
          <ProjectPicker
            variant="field"
            targets={targets}
            value={captureTarget?.id ?? ''}
            onChange={setCaptureTo}
            testId="capture-project"
            ariaLabel="Capture into"
            title="Where new captures go — stays selected until you leave Tasks"
            placeholder="Unassigned — assign later"
            noneLabel="Unassigned — assign later"
            newProject={newProject}
          />
        </span>
        <button className="px-btn px-btn--primary" type="submit" data-testid="activity-add">Capture</button>
      </form>

      <div className="px-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'byproject'} data-testid="tasks-tab-byproject" className={`px-tab${tab === 'byproject' ? ' px-tab--on' : ''}`} onClick={() => pickTab('byproject')}>
          <Ic name="layers" /> By project
        </button>
        <button role="tab" aria-selected={tab === 'bystatus'} data-testid="tasks-tab-bystatus" className={`px-tab${tab === 'bystatus' ? ' px-tab--on' : ''}`} onClick={() => pickTab('bystatus')}>
          <Ic name="cols" /> By status
        </button>
        <button role="tab" aria-selected={tab === 'completed'} data-testid="tasks-tab-completed" className={`px-tab${tab === 'completed' ? ' px-tab--on' : ''}`} onClick={() => pickTab('completed')}>
          <Ic name="check" /> Completed
        </button>
        <button role="tab" aria-selected={tab === 'deleted'} data-testid="tasks-tab-deleted" className={`px-tab${tab === 'deleted' ? ' px-tab--on' : ''}`} onClick={() => pickTab('deleted')}>
          <Ic name="trash" /> Recently deleted
        </button>
      </div>

      <div ref={panelRef} role="tabpanel" style={{ maxWidth: 900 }}>
        {tab === 'completed' ? (
          <CompletedPanel commands={commands} detail={detail} />
        ) : tab === 'deleted' ? (
          <DeletedPanel commands={commands} now={now} />
        ) : tab === 'byproject' ? (
          <>
            <div className="px-sec">Unassigned <span className="px-sec-cnt">· {activities.length} — no parent yet</span><span className="px-sec-ln" /></div>
            <ul className="px-rows" data-testid="inbox">
              {activities.length === 0 && <li className="px-trow px-muted">{hydrated ? 'Nothing unassigned.' : 'Loading…'}</li>}
              {inboxNewestFirst.map((a) => (
                <InboxRow key={a.id} activity={a} targets={targets} newProject={newProject} commands={commands} detail={detail} onComplete={() => setCompleting(a)} />
              ))}
            </ul>

            {groups.map((g) => {
              const collapsed = projectFolds.isCollapsed(g.project.id);
              return (
                <div key={g.project.id}>
                  <button
                    type="button"
                    className="px-sec px-sec--clps"
                    data-testid={`project-toggle-${g.project.id}`}
                    aria-expanded={!collapsed}
                    aria-controls={`project-group-${g.project.id}`}
                    title={collapsed ? 'Show this project’s tasks' : 'Hide this project’s tasks'}
                    onClick={() => projectFolds.toggle(g.project.id)}
                  >
                    <Ic name="chevd" className="px-ic px-sec-cv" />
                    <ProjectDot tree={tree} projectId={g.project.id} />
                    {g.project.title} <span className="px-sec-cnt">· {g.tasks.length}</span><span className="px-sec-ln" />
                  </button>
                  <ul className={`px-rows${collapsed ? ' px-hide' : ''}`} id={`project-group-${g.project.id}`} data-testid={`project-group-${g.project.id}`}>
                    {g.tasks.map((t) => (
                      <TaskRow key={t.task.id} task={t.task} status={t.status} blockedBy={t.blockedBy} steps={stepsByTask.get(t.task.id) ?? []} running={running.has(t.task.id)} commands={commands} detail={detail} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </>
        ) : (
          <>
            <div className="px-sec">Available <span className="px-sec-cnt">· {available.length} — priority order</span><span className="px-sec-ln" /></div>
            <ul className="px-rows" data-testid="status-available">
              {available.length === 0 && <li className="px-trow px-muted">Nothing available.</li>}
              {available.map((it) => (
                <AvailableStatusRow key={it.task.id} item={it} running={running.has(it.task.id)} commands={commands} detail={detail} onCheck={() => void commands.checkOff(it.task.id)} />
              ))}
            </ul>

            {blocked.length > 0 && (
              <>
                <div className="px-sec" style={{ color: 'var(--px-red)' }}>Blocked <span className="px-sec-cnt">· {blocked.length}</span><span className="px-sec-ln" /></div>
                <ul className="px-rows px-rows--muted" data-testid="status-blocked">
                  {blocked.map((b) => (
                    <li className="px-trow" key={b.task.id} {...detail.rowProps(b.task.id)}>
                      <span className="px-ckb" style={{ opacity: 0.4 }}><Ic name="check" /></span>
                      <div className="px-t-main"><div className="px-t-title" style={{ color: 'var(--px-text-dim)' }}><RunningDot running={running.has(b.task.id)} /><EditableTitle node={b.task} commands={commands} /></div></div>
                      <span className="px-tag px-tag--red"><Ic name="alert" />{b.blockedBy[0] ?? 'blocked'}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="px-sec">Unassigned <span className="px-sec-cnt">· {activities.length}</span><span className="px-sec-ln" /></div>
            <ul className="px-rows" data-testid="status-inbox">
              {activities.length === 0 && <li className="px-trow px-muted">Nothing unassigned.</li>}
              {inboxNewestFirst.map((a) => (
                <li className="px-trow" key={a.id} {...detail.rowProps(a.id)}>
                  <InboxCheck activity={a} onComplete={() => setCompleting(a)} />
                  <div className="px-t-main"><div className="px-t-title"><EditableTitle node={a} commands={commands} /></div></div>
                </li>
              ))}
            </ul>

            {doneToday.length > 0 && (
              <>
                <div className="px-sec" style={{ color: 'var(--px-green)' }}>Done today <span className="px-sec-cnt">· {doneToday.length}</span><span className="px-sec-ln" /></div>
                <ul className="px-rows px-rows--muted" data-testid="status-done">
                  {doneToday.map((d) => (
                    <li className="px-trow px-trow--done" key={d.task.id} data-testid={`done-${d.task.id}`} {...detail.rowProps(d.task.id)}>
                      <button className="px-ckb px-ckb--done" data-testid={`reopen-${d.task.id}`} aria-label="Reopen" title="Reopen" onClick={() => void commands.uncheck(d.task.id)}><Ic name="check" /></button>
                      <div className="px-t-main"><div className="px-t-title"><EditableTitle node={d.task} commands={commands} /></div></div>
                      {d.unfocused && <UnfocusedTag />}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>

      <CompleteInboxDialog activity={completing} targets={targets} newProject={newProject} commands={commands} onClose={() => setCompleting(null)} />
    </section>
  );
}

/** A day heading for an ISO instant, in local time: "Today", "Yesterday", else "Mon 17 Nov". */
function dayLabel(iso: string, nowMs: number): string {
  const d = new Date(iso);
  const key = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const today = new Date(nowMs);
  const yesterday = new Date(nowMs - 24 * 60 * 60 * 1000);
  if (key(d) === key(today)) return 'Today';
  if (key(d) === key(yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

/** Consecutive runs of `items` sharing a day label, in order. */
function byDay<T>(items: readonly T[], isoOf: (item: T) => string, nowMs: number): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = dayLabel(isoOf(item), nowMs);
    const last = out.at(-1);
    if (last && last.label === label) last.items.push(item);
    else out.push({ label, items: [item] });
  }
  return out;
}

/**
 * Tasks › Completed: every finished task and capture, newest first, under a
 * heading per day. The green tick reopens one; the rest of the row opens its
 * details card, like everywhere else.
 */
function CompletedPanel({ commands, detail }: { commands: PrismsCommands; detail: TaskDetailApi }) {
  const completed = useCompletedTasks();
  const hydrated = useIsHydrated();
  const nowMs = Date.now();
  if (completed.length === 0) {
    return (
      <ul className="px-rows" data-testid="completed-list">
        <li className="px-trow px-muted">{hydrated ? 'Nothing completed yet.' : 'Loading…'}</li>
      </ul>
    );
  }
  return (
    <div data-testid="completed-list">
      {byDay(completed, (d) => d.task.completed_at ?? '', nowMs).map((day) => (
        <div key={day.label}>
          <div className="px-sec">{day.label} <span className="px-sec-cnt">· {day.items.length}</span><span className="px-sec-ln" /></div>
          <ul className="px-rows px-rows--muted">
            {day.items.map((d) => (
              <li className="px-trow px-trow--done" key={d.task.id} data-testid={`completed-${d.task.id}`} {...detail.rowProps(d.task.id)}>
                <button className="px-ckb px-ckb--done" data-testid={`reopen-${d.task.id}`} aria-label="Reopen" title="Reopen" onClick={() => void commands.uncheck(d.task.id)}><Ic name="check" /></button>
                <div className="px-t-main">
                  <div className="px-t-title"><EditableTitle node={d.task} commands={commands} /></div>
                  {d.projectTitle && (
                    <div className="px-t-meta">
                      <span className="px-proj"><span className={`px-pdot px-pdot--${projectTone(d.projectId)}`} />{d.projectTitle}</span>
                    </div>
                  )}
                </div>
                {d.task.completion_disposition === 'obsolete' && <span className="px-tag px-tag--grey">obsolete</span>}
                {d.unfocused && <UnfocusedTag />}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * Tasks › Recently deleted: what was deleted in the last RECENTLY_DELETED_DAYS,
 * newest first, each with Restore. Deleted rows only reach this device through
 * the lazy `history` stream, so the panel holds it open while it shows (and lets
 * it go — PowerSync's TTL evicts the rows later — when you leave). Rows already
 * on the device show at once; useHistoryStream says when more can't arrive.
 */
function DeletedPanel({ commands, now }: { commands: PrismsCommands; now: Instant }) {
  const db = usePowerSync();
  const status = useStatus();
  const history = useHistoryStream(db as unknown as StreamSubscriber);

  const deleted = useRecentlyDeleted(now);
  const [failed, setFailed] = useState<string | null>(null);
  async function restore(id: string) {
    setFailed(null);
    try {
      await commands.restore(id);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    }
  }

  const nowMs = Date.now();
  const notice = historyNotice(history, status.connected);
  const emptyText = history === 'synced' ? 'Nothing deleted recently.' : notice !== null ? 'Nothing deleted on this device.' : 'Loading…';
  return (
    <div data-testid="deleted-list" data-history={history}>
      <p className="px-deleted-note">Tasks and captures deleted in the last {RECENTLY_DELETED_DAYS} days. Restore puts one back where it was, with its steps.</p>
      {notice && <p className="px-deleted-warn" role="status" data-testid="deleted-notice">{notice}</p>}
      {failed && <p className="px-error" role="alert">{failed}</p>}
      {deleted.length === 0 ? (
        <ul className="px-rows">
          <li className="px-trow px-muted">{emptyText}</li>
        </ul>
      ) : (
        byDay(deleted, (d) => d.deletedAt, nowMs).map((day) => (
          <div key={day.label}>
            <div className="px-sec">{day.label} <span className="px-sec-cnt">· {day.items.length}</span><span className="px-sec-ln" /></div>
            <ul className="px-rows px-rows--muted">
              {day.items.map((d) => (
                <li className="px-trow px-trow--deleted" key={d.task.id} data-testid={`deleted-${d.task.id}`}>
                  <span className="px-deleted-ic"><Ic name="trash" /></span>
                  <div className="px-t-main">
                    <div className="px-t-title">{d.task.title}</div>
                    <div className="px-t-meta">
                      {d.projectTitle ? (
                        <span className="px-proj"><span className={`px-pdot px-pdot--${projectTone(d.projectId)}`} />{d.projectTitle}</span>
                      ) : (
                        <span>Inbox</span>
                      )}
                      {d.task.completed_at !== null && <span>done</span>}
                    </div>
                  </div>
                  <button className="px-btn px-btn--sm" data-testid={`restore-${d.task.id}`} onClick={() => void restore(d.task.id)}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}

function InboxCheck({ activity, onComplete }: { activity: Node; onComplete: () => void }) {
  return (
    // The label leaves the title out: the row already names the item, and an
    // item called e.g. "Assign…" would otherwise share a name with that button.
    <button className="px-ckb" data-testid={`inbox-check-${activity.id}`} aria-label="Complete this capture" title="Complete" onClick={onComplete}>
      <Ic name="check" />
    </button>
  );
}

/**
 * Completing an Inbox capture asks first: it has no project, so either give it
 * one (promote, then check off — it becomes an ordinary completed task) or
 * complete it as it is, an unfocused task.
 */
function CompleteInboxDialog({ activity, targets, newProject, commands, onClose }: { activity: Node | null; targets: PromoteTarget[]; newProject: NewProjectApi | undefined; commands: PrismsCommands; onClose: () => void }) {
  // Like the Inbox row: nothing preselected, so "Add & complete" waits for a choice.
  const [parentId, setParentId] = useState('');
  const selected = targets.some((t) => t.id === parentId) ? parentId : '';
  const [busy, setBusy] = useState(false);

  async function finish(withProject: boolean) {
    if (!activity || busy) return;
    setBusy(true);
    try {
      if (withProject) await commands.promoteActivity(activity.id, { parentId: selected });
      await commands.checkOff(activity.id);
      setParentId('');
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={activity !== null}
      title={`Complete “${activity?.title ?? ''}”`}
      onClose={onClose}
      actions={
        <>
          <button className="px-btn" onClick={onClose}>Cancel</button>
          <button className="px-btn" data-testid="inbox-complete-unfocused" disabled={busy} onClick={() => void finish(false)}>
            Complete as unfocused task
          </button>
        </>
      }
    >
      <div data-testid="inbox-complete-dialog">
        <p className="px-modal-sub">This capture isn't in a project yet. Add it to one so the work counts toward that project, or just complete it as an unfocused task.</p>
        <div className="px-field">
          <span>Add to a project</span>
          <span className="px-promote px-promote--field">
            <ProjectPicker
              variant="field"
              targets={targets}
              value={selected}
              onChange={setParentId}
              testId="inbox-complete-target"
              emptyLabel="No project to add it to"
              newProject={newProject}
            />
            <button
              className="px-btn px-btn--primary"
              data-testid="inbox-complete-promote"
              disabled={selected === '' || busy}
              onClick={() => void finish(true)}
            >
              Add &amp; complete
            </button>
          </span>
        </div>
      </div>
    </Modal>
  );
}

function InboxRow({ activity, targets, newProject, commands, detail, onComplete }: { activity: Node; targets: PromoteTarget[]; newProject: NewProjectApi | undefined; commands: PrismsCommands; detail: TaskDetailApi; onComplete: () => void }) {
  // Nothing preselected: the picker reads "Assign project" until one is chosen,
  // and Assign stays off. A choice whose project has since gone counts as none.
  const [parentId, setParentId] = useState('');
  const selected = targets.some((t) => t.id === parentId) ? parentId : '';
  return (
    <li className="px-trow px-trow--inbox" {...detail.rowProps(activity.id)}>
      <InboxCheck activity={activity} onComplete={onComplete} />
      <div className="px-t-main"><div className="px-t-title"><EditableTitle node={activity} commands={commands} /></div></div>
      <span className="px-promote">
        <ProjectPicker targets={targets} value={selected} onChange={setParentId} testId={`promote-target-${activity.id}`} newProject={newProject} />
        <button
          className="px-btn px-btn--sm px-btn--primary"
          data-testid={`promote-${activity.id}`}
          disabled={selected === ''}
          onClick={() => void commands.promoteActivity(activity.id, { parentId: selected })}
        >
          Assign
        </button>
      </span>
      <InboxDelete title={activity.title} onDelete={() => void commands.softDelete(activity.id)} />
    </li>
  );
}

function AvailableStatusRow({ item, running, commands, detail, onCheck }: { item: MyDayItem; running: boolean; commands: PrismsCommands; detail: TaskDetailApi; onCheck: () => void }) {
  return (
    <li className="px-trow" {...detail.rowProps(item.task.id)}>
      <button className="px-ckb" data-testid={`task-check-${item.task.id}`} aria-label="check off" onClick={onCheck}><Ic name="check" /></button>
      <div className="px-t-main">
        <div className="px-t-title"><RunningDot running={running} /><EditableTitle node={item.task} commands={commands} /></div>
        <div className="px-t-meta">
          {item.projectTitle && <span className="px-proj"><span className={`px-pdot px-pdot--${projectTone(item.projectId)}`} />{item.projectTitle}</span>}
          {item.priority !== null && <span className="px-prio">prio {item.priority.toFixed(1)}</span>}
        </div>
      </div>
    </li>
  );
}

function TaskRow({ task, status, blockedBy, steps, running, commands, detail }: { task: Node; status: TaskStatus; blockedBy: string[]; steps: TaskStep[]; running: boolean; commands: PrismsCommands; detail: TaskDetailApi }) {
  const [open, setOpen] = useState(false);
  const isBlocked = status === 'blocked';
  const location = locationOf(task);
  return (
    <>
      <li className="px-trow" data-testid={`task-row-${task.id}`} {...detail.rowProps(task.id)}>
        <button className="px-ckb" data-testid={`task-check-${task.id}`} aria-label="check off" disabled={isBlocked} onClick={() => void commands.checkOff(task.id)}><Ic name="check" /></button>
        <div className="px-t-main">
          <div className="px-t-title" style={isBlocked ? { color: 'var(--px-text-dim)' } : undefined}><RunningDot running={running} /><EditableTitle node={task} commands={commands} /></div>
          <div className="px-t-meta">
            {task.estimate_minutes != null && <span>est {formatMinutes(task.estimate_minutes)}</span>}
            {task.due_date && <DueDate date={task.due_date} />}
            {location !== '' && <span className="px-t-loc" title={location}><Ic name="pin" />{location}</span>}
          </div>
        </div>
        {isBlocked ? (
          <span className="px-tag px-tag--red"><Ic name="alert" />{blockedBy[0] ?? 'blocked'}</span>
        ) : (
          <StepsToggle taskId={task.id} steps={steps} open={open} onToggle={() => setOpen((o) => !o)} />
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
