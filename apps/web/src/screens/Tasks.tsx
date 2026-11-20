/**
 * Tasks (web redesign W4/D6) — one screen for every task, absorbing the old
 * Inbox. A capture bar mints a parentless `activity`; two grouping tabs follow:
 *   • By project — the Inbox group FIRST (promote-to-parent), then one group per
 *     project walking the tree, each task row carrying its checklist substeps
 *     (W3 task_steps: expand, add-on-Enter, toggle, inline rename).
 *   • By status — Available (priority order) / Blocked / Inbox / Done today.
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

import { asEpochMillis, initialSortOrder, sortOrderBetween, type Instant, type Node, type TaskStatus, type TaskStep } from '@prisms/core';
import {
  Ic,
  Modal,
  useActivityInbox,
  useBlockedTasks,
  useCommands,
  useDoneToday,
  useIsHydrated,
  useMyDayAvailable,
  useNodeTree,
  usePromoteTargets,
  useTaskStepsByTask,
  useTasksByProject,
  type PrismsCommands,
  type CommandContext,
  type MyDayItem,
  type PromoteTarget,
} from '@prisms/ui';

import { InboxDelete } from '../components/InboxDelete';
import { ProjectPicker } from '../components/ProjectPicker';
import { EditableTitle, locationOf, useTaskDetail, type TaskDetailApi } from '../components/TaskDetail';
import { useTabSwap } from '../components/tabSwap';
import { UnfocusedTag } from '../components/UnfocusedTag';
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
  const [tab, setTab] = useState<'byproject' | 'bystatus'>('byproject');
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

  async function capture(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (t === '') return;
    if (captureTarget) {
      // straight into the chosen project, at the end of its list
      const last = tree.childrenByParent.get(captureTarget.id)?.at(-1)?.sort_order ?? null;
      const sortOrder = last === null ? initialSortOrder() : sortOrderBetween(last, null);
      await commands.createTask({ parentId: captureTarget.id, title: t, sortOrder });
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
        <span className="px-page-sub">every task in one list — captures wait in Inbox until assigned</span>
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
            placeholder="Inbox — assign later"
            noneLabel="Inbox — assign later"
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
      </div>

      <div ref={panelRef} role="tabpanel" style={{ maxWidth: 900 }}>
        {tab === 'byproject' ? (
          <>
            <div className="px-sec">Inbox <span className="px-sec-cnt">· {activities.length} — no parent yet</span><span className="px-sec-ln" /></div>
            <ul className="px-rows" data-testid="inbox">
              {activities.length === 0 && <li className="px-trow px-muted">{hydrated ? 'Inbox is empty.' : 'Loading…'}</li>}
              {inboxNewestFirst.map((a) => (
                <InboxRow key={a.id} activity={a} targets={targets} commands={commands} detail={detail} onComplete={() => setCompleting(a)} />
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
                    <TaskRow key={t.task.id} task={t.task} status={t.status} blockedBy={t.blockedBy} steps={stepsByTask.get(t.task.id) ?? []} commands={commands} detail={detail} />
                  ))}
                </ul>
              </div>
            ))}
          </>
        ) : (
          <>
            <div className="px-sec">Available <span className="px-sec-cnt">· {available.length} — priority order</span><span className="px-sec-ln" /></div>
            <ul className="px-rows" data-testid="status-available">
              {available.length === 0 && <li className="px-trow px-muted">Nothing available.</li>}
              {available.map((it) => (
                <AvailableStatusRow key={it.task.id} item={it} commands={commands} detail={detail} onCheck={() => void commands.checkOff(it.task.id)} />
              ))}
            </ul>

            {blocked.length > 0 && (
              <>
                <div className="px-sec" style={{ color: 'var(--px-red)' }}>Blocked <span className="px-sec-cnt">· {blocked.length}</span><span className="px-sec-ln" /></div>
                <ul className="px-rows px-rows--muted" data-testid="status-blocked">
                  {blocked.map((b) => (
                    <li className="px-trow" key={b.task.id} {...detail.rowProps(b.task.id)}>
                      <span className="px-ckb" style={{ opacity: 0.4 }}><Ic name="check" /></span>
                      <div className="px-t-main"><div className="px-t-title" style={{ color: 'var(--px-text-dim)' }}><EditableTitle node={b.task} commands={commands} /></div></div>
                      <span className="px-tag px-tag--red"><Ic name="alert" />{b.blockedBy[0] ?? 'blocked'}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="px-sec">Inbox <span className="px-sec-cnt">· {activities.length}</span><span className="px-sec-ln" /></div>
            <ul className="px-rows" data-testid="status-inbox">
              {activities.length === 0 && <li className="px-trow px-muted">Inbox is empty.</li>}
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
                      <span className="px-ckb px-ckb--done"><Ic name="check" /></span>
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

      <CompleteInboxDialog activity={completing} targets={targets} commands={commands} onClose={() => setCompleting(null)} />
    </section>
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
function CompleteInboxDialog({ activity, targets, commands, onClose }: { activity: Node | null; targets: PromoteTarget[]; commands: PrismsCommands; onClose: () => void }) {
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

function InboxRow({ activity, targets, commands, detail, onComplete }: { activity: Node; targets: PromoteTarget[]; commands: PrismsCommands; detail: TaskDetailApi; onComplete: () => void }) {
  // Nothing preselected: the picker reads "Assign project" until one is chosen,
  // and Assign stays off. A choice whose project has since gone counts as none.
  const [parentId, setParentId] = useState('');
  const selected = targets.some((t) => t.id === parentId) ? parentId : '';
  return (
    <li className="px-trow px-trow--inbox" {...detail.rowProps(activity.id)}>
      <InboxCheck activity={activity} onComplete={onComplete} />
      <div className="px-t-main"><div className="px-t-title"><EditableTitle node={activity} commands={commands} /></div></div>
      <span className="px-promote">
        <ProjectPicker targets={targets} value={selected} onChange={setParentId} testId={`promote-target-${activity.id}`} />
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

function AvailableStatusRow({ item, commands, detail, onCheck }: { item: MyDayItem; commands: PrismsCommands; detail: TaskDetailApi; onCheck: () => void }) {
  return (
    <li className="px-trow" {...detail.rowProps(item.task.id)}>
      <button className="px-ckb" data-testid={`task-check-${item.task.id}`} aria-label="check off" onClick={onCheck}><Ic name="check" /></button>
      <div className="px-t-main">
        <div className="px-t-title"><EditableTitle node={item.task} commands={commands} /></div>
        <div className="px-t-meta">
          {item.projectTitle && <span className="px-proj"><span className={`px-pdot px-pdot--${projectTone(item.projectId)}`} />{item.projectTitle}</span>}
          {item.priority !== null && <span className="px-prio">prio {item.priority.toFixed(1)}</span>}
        </div>
      </div>
    </li>
  );
}

function TaskRow({ task, status, blockedBy, steps, commands, detail }: { task: Node; status: TaskStatus; blockedBy: string[]; steps: TaskStep[]; commands: PrismsCommands; detail: TaskDetailApi }) {
  const [open, setOpen] = useState(false);
  const isBlocked = status === 'blocked';
  const doneCount = steps.filter((s) => s.done).length;
  const stepsLabel = steps.length === 0 ? '+ steps' : doneCount > 0 ? `${doneCount}/${steps.length} steps` : `${steps.length} steps`;
  const location = locationOf(task);
  return (
    <>
      <li className="px-trow" data-testid={`task-row-${task.id}`} {...detail.rowProps(task.id)}>
        <button className="px-ckb" data-testid={`task-check-${task.id}`} aria-label="check off" disabled={isBlocked} onClick={() => void commands.checkOff(task.id)}><Ic name="check" /></button>
        <div className="px-t-main">
          <div className="px-t-title" style={isBlocked ? { color: 'var(--px-text-dim)' } : undefined}><EditableTitle node={task} commands={commands} /></div>
          <div className="px-t-meta">
            {task.estimate_minutes != null && <span>est {formatMinutes(task.estimate_minutes)}</span>}
            {task.due_date && <span>due {task.due_date.slice(5)}</span>}
            {location !== '' && <span className="px-t-loc" title={location}><Ic name="pin" />{location}</span>}
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
