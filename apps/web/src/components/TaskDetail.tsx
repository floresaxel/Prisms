/**
 * Task details — click a task row to open a card that edits everything the task
 * carries; click a row's TITLE to rename it in place without opening anything.
 *
 * Every field rides an existing verb, so there is no new column and no migration:
 *   title → node.rename · details → node.set_description · start / expected
 *   completion → node.set_dates · hours budget → node.set_estimate (stored in
 *   minutes) · location → node.set_attributes (`attributes.location`; the verb
 *   REPLACES the bag, so the other keys are spread back in) · project →
 *   node.move for a task, activity.promote for an Inbox capture · steps → step.*
 *   · dependencies → edge.* (finish-to-start).
 *
 * The card is compact: beyond the title and project, a field shows only when
 * the task has a value for it or once it is added from the "+" chips under the
 * project (td-add-<start|due|hours|location|details|steps|deps>), which focus
 * the new field.
 *
 * Fields save when they lose focus (Enter too, for one-line fields), and closing
 * the card blurs the focused field first so an edit in progress is kept. Escape
 * in a field with unsaved text puts the stored value back; Escape anywhere else
 * closes the card.
 *
 * One dialog serves every screen: `TaskDetailProvider` (mounted by the app
 * shell) owns it, and a row opts in with `useTaskDetail().rowProps(taskId)`.
 *
 * Testids: td-dialog, td-title, td-project, td-start, td-due, td-hours,
 * td-logged, td-location, td-details, td-step-add, td-step-<id>, td-dep-add-before,
 * td-dep-add-after, td-dep-<edgeId>, td-delete, td-done; rows' titles are
 * title-<taskId> (button) / title-input-<taskId> (inline rename).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

import {
  ancestorsOf,
  asEpochMillis,
  findEdgeBetween,
  incomingEdges,
  initialSortOrder,
  MAX_DESCRIPTION_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_TITLE_LENGTH,
  outgoingEdges,
  sortOrderBetween,
  taskStatus,
  wouldCreateCycle,
  type Edge,
  type FactContext,
  type Node,
  type TaskStep,
} from '@prisms/core';
import {
  Ic,
  Modal,
  useCommands,
  useFactContext,
  usePromoteTargets,
  useTaskProgress,
  useTaskSteps,
  type CommandContext,
  type PrismsCommands,
  type PromoteTarget,
} from '@prisms/ui';

import { formatMinutes, projectTone, rejectionMessage } from '../format';

// --- the shared controller ------------------------------------------------------

export interface TaskDetailApi {
  /** Open the details card on a task (or Inbox capture). */
  open: (taskId: string) => void;
  /**
   * Spread onto a list row: a click on the row — anywhere but its own controls
   * (check box, buttons, selects, the click-to-rename title) — opens the card,
   * and so does Enter/Space while the row itself has focus. A click that ends a
   * drag (selecting the row's text, say) does not.
   */
  rowProps: (taskId: string) => {
    onMouseDown: (e: MouseEvent<HTMLElement>) => void;
    onClick: (e: MouseEvent<HTMLElement>) => void;
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
    tabIndex: number;
    'aria-haspopup': 'dialog';
    'data-opens-detail': string;
  };
}

const TaskDetailContext = createContext<TaskDetailApi | null>(null);

export function useTaskDetail(): TaskDetailApi {
  const api = useContext(TaskDetailContext);
  if (!api) throw new Error('useTaskDetail must be used inside <TaskDetailProvider>');
  return api;
}

/** Elements inside a row that keep their own click (they never open the card). */
const ROW_CONTROLS = 'button, a, input, select, textarea, label, [role="button"]';

function fromRowControl(target: EventTarget, row: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest(ROW_CONTROLS);
  return control !== null && control !== row && row.contains(control);
}

/** How far (px) the pointer may travel between press and release and still count as a click. */
const CLICK_SLOP = 4;

/** True when the page has text selected inside `row` — the click ended a selection. */
function selectsTextIn(row: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    if (range.intersectsNode(row) && range.toString().trim() !== '') return true;
  }
  return false;
}

export function TaskDetailProvider({ ctx, children }: { ctx: CommandContext; children: ReactNode }) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const open = useCallback((id: string) => setTaskId(id), []);
  /**
   * Where the last press on a row landed, and whether it was on one of the
   * row's controls. A press that starts on the title and is released elsewhere
   * on the row (a drag over its text) still fires `click` — on the row — so the
   * row checks the press before it opens anything.
   */
  const press = useRef<{ x: number; y: number; onControl: boolean } | null>(null);
  const close = useCallback(() => {
    // Keep an edit in progress: blurring runs the focused field's save before
    // the card (and the field) unmount — removing an element fires no blur.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('[data-testid="td-dialog"]')) active.blur();
    setTaskId(null);
  }, []);

  const api = useMemo<TaskDetailApi>(
    () => ({
      open,
      rowProps: (id: string) => ({
        onMouseDown: (e: MouseEvent<HTMLElement>) => {
          press.current = { x: e.clientX, y: e.clientY, onControl: fromRowControl(e.target, e.currentTarget) };
        },
        onClick: (e: MouseEvent<HTMLElement>) => {
          const p = press.current;
          press.current = null;
          if (fromRowControl(e.target, e.currentTarget)) return;
          // a drag, not a click: it started on a control (the title) or moved
          if (p && (p.onControl || Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP)) return;
          if (selectsTextIn(e.currentTarget)) return;
          open(id);
        },
        onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open(id);
          }
        },
        tabIndex: 0,
        'aria-haspopup': 'dialog',
        'data-opens-detail': '',
      }),
    }),
    [open],
  );

  return (
    <TaskDetailContext.Provider value={api}>
      {children}
      <TaskDetailDialog taskId={taskId} ctx={ctx} onOpenTask={open} onClose={close} />
    </TaskDetailContext.Provider>
  );
}

// --- click-to-rename title --------------------------------------------------------

/**
 * The character offset under a click inside `el`'s single text node — where the
 * caret should land when the text turns into an input — or null when the browser
 * can't say (then the caret goes to the end).
 */
function textOffsetAt(el: HTMLElement, x: number, y: number): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: unknown; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let hit: { node: unknown; offset: number } | null = null;
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) hit = { node: pos.offsetNode, offset: pos.offset };
  else {
    const range = doc.caretRangeFromPoint?.(x, y);
    if (range) hit = { node: range.startContainer, offset: range.startOffset };
  }
  // (`Node` here is the task-tree type, so the DOM check goes by `Text`)
  return hit !== null && hit.node instanceof Text && el.contains(hit.node) ? hit.offset : null;
}

/**
 * A row's title. Clicking the text turns it into an input right there, with the
 * caret where the click landed (nothing selected): Enter or clicking away saves,
 * Escape leaves the title as it was. The row's other clicks still open the
 * details card.
 */
export function EditableTitle({ node, commands }: { node: Node; commands: PrismsCommands }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.title);
  /** Where the click that started the edit landed in the title text. */
  const caretAt = useRef<number | null>(null);

  function commit() {
    setEditing(false);
    const t = draft.trim();
    if (t !== '' && t !== node.title) void commands.rename(node.id, t);
  }

  if (editing) {
    return (
      <input
        className="px-title-input"
        data-testid={`title-input-${node.id}`}
        aria-label="Task title"
        value={draft}
        maxLength={MAX_TITLE_LENGTH}
        autoFocus
        onFocus={(e) => {
          // a bare caret, never a selection: at the click, else at the end
          const at = Math.min(caretAt.current ?? e.currentTarget.value.length, e.currentTarget.value.length);
          caretAt.current = null;
          e.currentTarget.setSelectionRange(at, at);
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            // a rename in progress is cancelled, not any dialog around it
            e.stopPropagation();
            setDraft(node.title);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className="px-title-btn"
      data-testid={`title-${node.id}`}
      onClick={(e) => {
        caretAt.current = textOffsetAt(e.currentTarget, e.clientX, e.clientY);
        setDraft(node.title);
        setEditing(true);
      }}
    >
      {node.title}
    </button>
  );
}

// --- the card -------------------------------------------------------------------------

/** The card's view of a task: the live node, or null once it is gone (deleted elsewhere). */
function TaskDetailDialog({ taskId, ctx, onOpenTask, onClose }: { taskId: string | null; ctx: CommandContext; onOpenTask: (id: string) => void; onClose: () => void }) {
  const facts = useFactContext();
  const node = taskId === null ? undefined : facts.tree.byId.get(taskId);
  const open = taskId !== null && node !== undefined;

  // The task vanished while open (deleted here or on another device): close.
  useEffect(() => {
    if (taskId !== null && node === undefined) onClose();
  }, [taskId, node, onClose]);

  return (
    <Modal open={open} size="card" label={node ? `Task details: ${node.title}` : 'Task details'} onClose={onClose} className="px-td">
      {/* keyed by task: every field's draft starts over when the card switches task */}
      {node && <TaskDetailBody key={node.id} node={node} facts={facts} ctx={ctx} onOpenTask={onOpenTask} onClose={onClose} />}
    </Modal>
  );
}

/**
 * A field's local draft. It follows the stored value while the field is not
 * being edited, so a change from another device (or this card's own save)
 * shows up, but never overwrites what the user is typing.
 */
function useDraft(stored: string) {
  const [draft, setDraft] = useState(stored);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(stored);
  }, [stored]);
  return {
    draft,
    setDraft,
    dirty: draft !== stored,
    onFocus: () => {
      editing.current = true;
    },
    /** Field left: stop protecting the draft; return it for the save. */
    release: () => {
      editing.current = false;
      return draft;
    },
    reset: () => setDraft(stored),
  };
}

/** Escape in a field with unsaved text: put the stored value back and keep the card open. */
function escapeReverts(e: KeyboardEvent<HTMLElement>, d: ReturnType<typeof useDraft>): void {
  if (e.key !== 'Escape' || !d.dirty) return;
  e.stopPropagation();
  d.reset();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Minutes → the hours text the budget field shows (2 decimals at most, no trailing zeros). */
export function hoursText(minutes: number | null): string {
  if (minutes === null) return '';
  return String(Math.round((minutes / 60) * 100) / 100);
}

/**
 * The hours field's text → stored minutes. '' clears the budget (null); a
 * value that rounds to 0 minutes clears it too (an estimate must be positive).
 * `undefined` = not a number — the field reverts.
 */
export function parseHours(text: string): number | null | undefined {
  const raw = text.trim().replace(',', '.');
  if (raw === '') return null;
  const h = Number(raw);
  if (!Number.isFinite(h) || h < 0) return undefined;
  const minutes = Math.round(h * 60);
  return minutes === 0 ? null : minutes;
}

/** `attributes.location`, or '' when the task has none. */
export function locationOf(node: Node): string {
  const v = node.attributes['location'];
  return typeof v === 'string' ? v : '';
}

function TaskDetailBody({ node, facts, ctx, onOpenTask, onClose }: { node: Node; facts: FactContext; ctx: CommandContext; onOpenTask: (id: string) => void; onClose: () => void }) {
  const commands = useCommands(ctx);
  const targets = usePromoteTargets();
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /** Run a write; a refusal shows in the card instead of vanishing. */
  const run = useCallback(async (write: () => Promise<void>) => {
    setError(null);
    try {
      await write();
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      setError(typeof code === 'string' && code !== 'E_PARSE' ? rejectionMessage(code) : e instanceof Error ? e.message : String(e));
    }
  }, []);

  const isTask = node.node_type === 'task';
  const isCapture = node.node_type === 'activity';
  const done = node.completed_at !== null;
  const trail = ancestorsOf(facts.tree, node.id).reverse();
  const project = trail.find((n) => n.node_type === 'project') ?? null;
  const status = isTask ? taskStatus(node, facts, asEpochMillis(Date.now())) : null;
  const kind = isCapture ? 'Inbox capture' : node.habit_id !== null ? 'Habit task' : 'Task';

  // ── title ──
  const title = useDraft(node.title);
  function saveTitle() {
    const t = title.release().trim();
    if (t === '' || t === node.title) {
      title.reset();
      return;
    }
    void run(() => commands.rename(node.id, t));
  }

  async function remove() {
    await run(() => commands.softDelete(node.id));
    onClose();
  }

  // ── which optional fields show: those with a value, plus the ones added here ──
  const steps = useTaskSteps(node.id);
  const progress = useTaskProgress(node.id);
  const frozen = done; // I8 spirit: a done task's checklist is frozen
  const has: Record<Extra, boolean> = {
    start: node.start_date !== null,
    due: node.due_date !== null,
    // the budget row also reports time logged, so it shows once any is
    hours: node.estimate_minutes !== null || (progress?.consumedMinutes ?? 0) >= 1,
    location: locationOf(node) !== '',
    details: node.description !== '',
    steps: isTask && steps.length > 0,
    deps: isTask && (incomingEdges(facts.edgeIndex, node.id).length > 0 || outgoingEdges(facts.edgeIndex, node.id).length > 0),
  };
  // A field that showed once stays while the card is open, so clearing it does
  // not yank it away mid-edit. (The body is keyed by task: a new task starts over.)
  const [added, setAdded] = useState<ReadonlySet<Extra>>(() => new Set(EXTRAS.filter((k) => has[k])));
  const shows = (k: Extra) => has[k] || added.has(k);
  const offer = EXTRAS.filter((k) => !shows(k) && (isTask || !TASK_ONLY.has(k)) && !(k === 'steps' && frozen));
  /** The field just added: focused once it is on screen. */
  const [focusNext, setFocusNext] = useState<string | null>(null);
  useEffect(() => {
    if (focusNext === null) return;
    document.getElementById(focusNext)?.focus();
    setFocusNext(null);
  }, [focusNext]);
  function add(k: Extra) {
    setAdded((s) => new Set(s).add(k));
    setFocusNext(EXTRA_UI[k].focus);
  }

  return (
    <div data-testid="td-dialog" data-task={node.id}>
      <div className="px-td-kicker">
        <span className="px-td-kind">{kind}</span>
        {trail.length > 0 && (
          <span className="px-td-crumb" title={trail.map((n) => n.title).join(' › ')}>
            {project && <span className={`px-pdot px-pdot--${projectTone(project.id)}`} />}
            {trail.map((n) => n.title).join(' › ')}
          </span>
        )}
        {done && <span className="px-tag px-tag--green" data-testid="td-status"><Ic name="check" />{node.completion_disposition === 'obsolete' ? 'obsolete' : 'done'}</span>}
        {status === 'blocked' && <span className="px-tag px-tag--red" data-testid="td-status"><Ic name="alert" />blocked</span>}
        <button type="button" className="px-td-x" aria-label="Close" onClick={onClose}><Ic name="x" /></button>
      </div>

      <input
        className="px-td-title"
        data-testid="td-title"
        aria-label="Title"
        value={title.draft}
        maxLength={MAX_TITLE_LENGTH}
        onFocus={title.onFocus}
        onChange={(e) => title.setDraft(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else escapeReverts(e, title);
        }}
      />

      <div className="px-td-props">
        <ProjectField node={node} facts={facts} targets={targets} commands={commands} run={run} />
        <DateRow node={node} start={shows('start')} due={shows('due')} commands={commands} run={run} />
        {shows('hours') && <BudgetField node={node} commands={commands} run={run} />}
        {shows('location') && <LocationField node={node} commands={commands} run={run} />}
      </div>

      {offer.length > 0 && (
        <div className="px-td-adds" data-testid="td-adds">
          {offer.map((k) => (
            <button key={k} type="button" className="px-td-add" data-testid={`td-add-${k}`} onClick={() => add(k)}>
              <Ic name="plus" />
              {EXTRA_UI[k].label}
            </button>
          ))}
        </div>
      )}

      {shows('details') && <DetailsField node={node} commands={commands} run={run} />}

      {isTask ? (
        <>
          {shows('steps') && <StepsSection node={node} commands={commands} run={run} />}
          {shows('deps') && <DependenciesSection node={node} facts={facts} commands={commands} run={run} onOpenTask={onOpenTask} />}
        </>
      ) : (
        <p className="px-td-hint" data-testid="td-capture-hint">Assign this capture to a project to give it steps and dependencies.</p>
      )}

      {error && <p className="px-error" role="alert" data-testid="td-error">{error}</p>}

      <div className="px-td-foot">
        {confirmDelete ? (
          <span className="px-td-confirm">
            Delete “{node.title}”?
            <button type="button" className="px-btn px-btn--sm px-btn--danger" data-testid="td-delete-confirm" onClick={() => void remove()}>Delete</button>
            <button type="button" className="px-btn px-btn--sm" onClick={() => setConfirmDelete(false)}>Keep</button>
          </span>
        ) : (
          <button type="button" className="px-btn px-btn--sm px-td-del" data-testid="td-delete" onClick={() => setConfirmDelete(true)}>
            <Ic name="trash" /> Delete
          </button>
        )}
        <span className="px-grow" />
        <button type="button" className="px-btn px-btn--primary" data-testid="td-done" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/**
 * The card's optional fields. Each shows only once it has a value or is added
 * from the card's "+" chips, so a bare task opens as a short card: kind, title,
 * project, and a row of what can be added.
 */
const EXTRAS = ['start', 'due', 'hours', 'location', 'details', 'steps', 'deps'] as const;
type Extra = (typeof EXTRAS)[number];
/** Only a task has these; an Inbox capture gets them once it is in a project. */
const TASK_ONLY: ReadonlySet<Extra> = new Set(['steps', 'deps']);
/** Each chip's label, and the element id focused when it is added. */
const EXTRA_UI: Record<Extra, { label: string; focus: string }> = {
  start: { label: 'Start date', focus: 'td-start' },
  due: { label: 'Expected completion', focus: 'td-due' },
  hours: { label: 'Budget', focus: 'td-hours' },
  location: { label: 'Location', focus: 'td-location' },
  details: { label: 'Details', focus: 'td-details' },
  steps: { label: 'Steps', focus: 'td-step-add' },
  deps: { label: 'Dependencies', focus: 'td-dep-add-before' },
};

type Run = (write: () => Promise<void>) => Promise<void>;
interface FieldProps {
  node: Node;
  commands: PrismsCommands;
  run: Run;
}

function Prop({ icon, label, htmlFor, children }: { icon: Parameters<typeof Ic>[0]['name']; label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <>
      <label className="px-td-k" htmlFor={htmlFor}><Ic name={icon} />{label}</label>
      <div className="px-td-v">{children}</div>
    </>
  );
}

/**
 * Project: a task moves under the chosen project or milestone (to the end of its
 * list); an Inbox capture is promoted into it — it becomes a task there. A
 * habit's task has no project (I3: a habit OR a parent, never both).
 */
function ProjectField({ node, facts, targets, commands, run }: FieldProps & { facts: FactContext; targets: PromoteTarget[] }) {
  if (node.node_type === 'task' && node.habit_id !== null) {
    return (
      <Prop icon="repeat" label="Project">
        <span className="px-td-note">Repeats with a habit — not in a project</span>
      </Prop>
    );
  }
  const isCapture = node.node_type === 'activity';
  const current = node.parent_id ?? '';
  // A milestone reads as "Project › Milestone" so two same-named milestones differ.
  const label = (t: PromoteTarget) => {
    if (t.type !== 'milestone') return t.title;
    const parent = facts.tree.byId.get(facts.tree.byId.get(t.id)?.parent_id ?? '');
    return parent ? `${parent.title} › ${t.title}` : `${t.title} (milestone)`;
  };
  const options = [...targets].map((t) => ({ id: t.id, text: label(t) })).sort((a, b) => a.text.localeCompare(b.text));

  function choose(parentId: string) {
    if (parentId === '' || parentId === current) return;
    if (isCapture) {
      void run(() => commands.promoteActivity(node.id, { parentId }));
      return;
    }
    const last = facts.tree.childrenByParent.get(parentId)?.at(-1)?.sort_order ?? null;
    const sortOrder = last === null ? initialSortOrder() : sortOrderBetween(last, null);
    void run(() => commands.moveNode(node.id, parentId, sortOrder));
  }

  return (
    <Prop icon="layers" label="Project" htmlFor="td-project">
      <select id="td-project" className="px-td-in px-td-in--grow" data-testid="td-project" value={current} onChange={(e) => choose(e.target.value)}>
        {isCapture && <option value="">Inbox — not in a project yet</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.text}</option>
        ))}
      </select>
    </Prop>
  );
}

/** One date input that saves as soon as a whole date is picked, and a clear on blur. */
function DateInput({ id, testId, value, onSave }: { id: string; testId: string; value: string | null; onSave: (v: string | null) => void }) {
  const d = useDraft(value ?? '');
  function save(v: string) {
    if (v === (value ?? '')) return;
    if (v !== '' && !ISO_DATE.test(v)) return;
    onSave(v === '' ? null : v);
  }
  return (
    <span className="px-td-date">
      <input
        id={id}
        type="date"
        className="px-td-in"
        data-testid={testId}
        value={d.draft}
        onFocus={d.onFocus}
        onChange={(e) => {
          d.setDraft(e.target.value);
          // a picked date saves at once; a cleared/partial one waits for blur
          if (e.target.value !== '') save(e.target.value);
        }}
        onBlur={() => save(d.release())}
        onKeyDown={(e) => escapeReverts(e, d)}
      />
      {value !== null && (
        <button type="button" className="px-td-clear" aria-label="Clear date" data-testid={`${testId}-clear`} onClick={() => onSave(null)}>
          <Ic name="x" />
        </button>
      )}
    </span>
  );
}

function DateRow({ node, start, due, commands, run }: FieldProps & { start: boolean; due: boolean }) {
  const backwards = node.start_date !== null && node.due_date !== null && node.start_date > node.due_date;
  return (
    <>
      {start && (
        <Prop icon="play" label="Starts" htmlFor="td-start">
          <DateInput id="td-start" testId="td-start" value={node.start_date} onSave={(v) => void run(() => commands.setDates(node.id, { startDate: v }))} />
        </Prop>
      )}
      {due && (
        <Prop icon="cal" label="Expected completion" htmlFor="td-due">
          <DateInput id="td-due" testId="td-due" value={node.due_date} onSave={(v) => void run(() => commands.setDates(node.id, { dueDate: v }))} />
          {backwards && <span className="px-td-note px-td-note--warn" data-testid="td-dates-warn">ends before it starts</span>}
        </Prop>
      )}
    </>
  );
}

/** Hours budget (the task's estimate) with the time logged against it so far. */
function BudgetField({ node, commands, run }: FieldProps) {
  const d = useDraft(hoursText(node.estimate_minutes));
  const progress = useTaskProgress(node.id);
  function save() {
    const minutes = parseHours(d.release());
    if (minutes === undefined || minutes === node.estimate_minutes) {
      d.reset();
      return;
    }
    void run(() => commands.setEstimate(node.id, minutes));
  }
  const logged = progress ? Math.round(progress.consumedMinutes) : 0;
  const over = progress?.ratio != null && progress.ratio > 1;
  return (
    <Prop icon="clock" label="Budget" htmlFor="td-hours">
      <input
        id="td-hours"
        className="px-td-in px-td-hours"
        data-testid="td-hours"
        inputMode="decimal"
        placeholder="—"
        value={d.draft}
        onFocus={d.onFocus}
        onChange={(e) => d.setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else escapeReverts(e, d);
        }}
      />
      <span className="px-td-unit">hours</span>
      <span className={`px-td-note${over ? ' px-td-note--over' : ''}`} data-testid="td-logged">
        {logged > 0 ? `${formatMinutes(logged)} logged` : 'nothing logged yet'}
        {progress?.ratio != null && logged > 0 && ` · ${Math.round(progress.ratio * 100)}% of budget`}
      </span>
    </Prop>
  );
}

function LocationField({ node, commands, run }: FieldProps) {
  const stored = locationOf(node);
  const d = useDraft(stored);
  function save() {
    const t = d.release().trim();
    if (t === stored) {
      d.reset();
      return;
    }
    // node.set_attributes REPLACES the bag: carry every other key over.
    const next: Record<string, unknown> = { ...node.attributes };
    if (t === '') delete next['location'];
    else next['location'] = t;
    void run(() => commands.setNodeAttributes(node.id, next));
  }
  return (
    <Prop icon="pin" label="Location" htmlFor="td-location">
      <input
        id="td-location"
        className="px-td-in px-td-in--grow"
        data-testid="td-location"
        placeholder="Where it happens — an address, a room, “online”…"
        maxLength={MAX_LABEL_LENGTH}
        value={d.draft}
        onFocus={d.onFocus}
        onChange={(e) => d.setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else escapeReverts(e, d);
        }}
      />
    </Prop>
  );
}

function DetailsField({ node, commands, run }: FieldProps) {
  const d = useDraft(node.description);
  function save() {
    const text = d.release().trimEnd();
    if (text === node.description) {
      d.reset();
      return;
    }
    void run(() => commands.setDescription(node.id, text));
  }
  const lines = d.draft.split('\n').length;
  return (
    <div className="px-td-sec">
      <label className="px-td-sec-h" htmlFor="td-details"><Ic name="note" />Details</label>
      <textarea
        id="td-details"
        className="px-td-in px-td-desc"
        data-testid="td-details"
        placeholder="Notes, links, acceptance criteria — anything someone doing this needs to know."
        maxLength={MAX_DESCRIPTION_LENGTH}
        rows={Math.min(14, Math.max(3, lines + 1))}
        value={d.draft}
        onFocus={d.onFocus}
        onChange={(e) => d.setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => escapeReverts(e, d)}
      />
    </div>
  );
}

// --- steps ----------------------------------------------------------------------------

function StepsSection({ node, commands, run }: FieldProps) {
  const steps = useTaskSteps(node.id);
  const frozen = node.completed_at !== null; // I8 spirit: a done task's checklist is frozen
  const [draft, setDraft] = useState('');
  const doneCount = steps.filter((s) => s.done).length;

  function add() {
    const t = draft.trim();
    if (t === '') return;
    const last = steps.at(-1)?.sort_order ?? null;
    const sortOrder = last === null ? initialSortOrder() : sortOrderBetween(last, null);
    setDraft('');
    void run(async () => {
      await commands.addStep({ taskId: node.id, title: t, sortOrder });
    });
  }
  /** Move step `i` one place up (-1) or down (+1): re-key it between its new neighbours. */
  function shift(i: number, dir: -1 | 1) {
    const step = steps[i];
    if (!step) return;
    const before = dir === -1 ? (steps[i - 2]?.sort_order ?? null) : (steps[i + 1]?.sort_order ?? null);
    const after = dir === -1 ? (steps[i - 1]?.sort_order ?? null) : (steps[i + 2]?.sort_order ?? null);
    if ((dir === -1 && i === 0) || (dir === 1 && i === steps.length - 1)) return;
    void run(() => commands.reorderStep(step.id, sortOrderBetween(before, after)));
  }

  return (
    <div className="px-td-sec" data-testid="td-steps">
      <div className="px-td-sec-h">
        <Ic name="tasklist" />Steps
        {steps.length > 0 && <span className="px-td-count">{doneCount}/{steps.length}</span>}
      </div>
      {steps.length === 0 && frozen && <p className="px-td-hint">No steps.</p>}
      <div className="px-td-steps">
        {steps.map((s, i) => (
          <StepRow
            key={s.id}
            step={s}
            frozen={frozen}
            first={i === 0}
            last={i === steps.length - 1}
            commands={commands}
            run={run}
            onUp={() => shift(i, -1)}
            onDown={() => shift(i, 1)}
          />
        ))}
      </div>
      {frozen ? (
        steps.length > 0 && <p className="px-td-hint">The task is done, so its steps are frozen.</p>
      ) : (
        <div className="px-addstep">
          <input
            id="td-step-add"
            data-testid="td-step-add"
            aria-label="Add a step"
            placeholder="Add a step — Enter to save"
            maxLength={MAX_TITLE_LENGTH}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              } else if (e.key === 'Escape' && draft !== '') {
                e.stopPropagation();
                setDraft('');
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

function StepRow({ step, frozen, first, last, commands, run, onUp, onDown }: { step: TaskStep; frozen: boolean; first: boolean; last: boolean; commands: PrismsCommands; run: Run; onUp: () => void; onDown: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(step.title);
  function commit() {
    setEditing(false);
    const t = draft.trim();
    if (t !== '' && t !== step.title) void run(() => commands.renameStep(step.id, t));
    else setDraft(step.title);
  }
  return (
    <div className={`px-sstep px-td-step${step.done ? ' px-sstep--done' : ''}`} data-testid={`td-step-${step.id}`}>
      <button
        type="button"
        className={`px-ss-ck${step.done ? ' px-ss-ck--done' : ''}`}
        aria-label={step.done ? `Mark “${step.title}” not done` : `Mark “${step.title}” done`}
        disabled={frozen}
        onClick={() => void run(() => commands.toggleStep(step.id, !step.done))}
      >
        <Ic name="check" />
      </button>
      {editing ? (
        <input
          className="px-sstep-input"
          aria-label="Step title"
          value={draft}
          maxLength={MAX_TITLE_LENGTH}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setDraft(step.title);
              setEditing(false);
            }
          }}
        />
      ) : frozen ? (
        <span className="px-sstep-txt">{step.title}</span>
      ) : (
        <button
          type="button"
          className="px-title-btn px-sstep-txt"
          onClick={() => {
            setDraft(step.title);
            setEditing(true);
          }}
        >
          {step.title}
        </button>
      )}
      {!frozen && !editing && (
        <span className="px-td-step-acts">
          {/* the sprite's up/down are upload/download trays; a chevron reads as "move" */}
          <button type="button" className="px-td-ib px-td-ib--flip" aria-label="Move step up" disabled={first} onClick={onUp}><Ic name="chevd" /></button>
          <button type="button" className="px-td-ib" aria-label="Move step down" disabled={last} onClick={onDown}><Ic name="chevd" /></button>
          <button type="button" className="px-td-ib px-td-ib--danger" aria-label={`Remove step “${step.title}”`} onClick={() => void run(() => commands.removeStep(step.id))}><Ic name="x" /></button>
        </span>
      )}
    </div>
  );
}

// --- dependencies -------------------------------------------------------------------------

interface DepCandidate {
  id: string;
  title: string;
  group: string;
}

/**
 * Tasks that can be linked on one side without breaking I4: another live, open
 * task, not already linked that way, and not one that would close a cycle.
 * Grouped by project for the picker.
 */
function dependencyCandidates(node: Node, facts: FactContext, side: 'before' | 'after'): Map<string, DepCandidate[]> {
  const groups = new Map<string, DepCandidate[]>();
  for (const t of facts.tree.byId.values()) {
    if (t.node_type !== 'task' || t.id === node.id || t.completed_at !== null) continue;
    const [pred, succ] = side === 'before' ? [t.id, node.id] : [node.id, t.id];
    if (findEdgeBetween(facts.edgeIndex, pred, succ) || wouldCreateCycle(facts.edgeIndex, pred, succ)) continue;
    const project = ancestorsOf(facts.tree, t.id).find((a) => a.node_type === 'project');
    const group = project?.title ?? (t.habit_id !== null ? 'Habit tasks' : 'Other tasks');
    const list = groups.get(group) ?? [];
    list.push({ id: t.id, title: t.title, group });
    groups.set(group, list);
  }
  for (const list of groups.values()) list.sort((a, b) => a.title.localeCompare(b.title));
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function DependenciesSection({ node, facts, commands, run, onOpenTask }: FieldProps & { facts: FactContext; onOpenTask: (id: string) => void }) {
  const waitsOn = incomingEdges(facts.edgeIndex, node.id);
  const blocks = outgoingEdges(facts.edgeIndex, node.id);
  const before = useMemo(() => dependencyCandidates(node, facts, 'before'), [node, facts]);
  const after = useMemo(() => dependencyCandidates(node, facts, 'after'), [node, facts]);

  return (
    <div className="px-td-sec" data-testid="td-deps">
      <div className="px-td-sec-h"><Ic name="net" />Dependencies</div>
      <div className="px-td-deps">
        <DepList
          heading="Waits on"
          hint="must finish before this can start"
          edges={waitsOn}
          other={(e) => e.predecessor_id}
          facts={facts}
          testId="td-dep-add-before"
          candidates={before}
          placeholder="+ Add a task this waits on…"
          onAdd={(id) => void run(async () => { await commands.createEdge({ predecessorId: id, successorId: node.id }); })}
          onRemove={(e) => void run(() => commands.deleteEdge(e.id))}
          onOpenTask={onOpenTask}
        />
        <DepList
          heading="Blocks"
          hint="can't start until this is done"
          edges={blocks}
          other={(e) => e.successor_id}
          facts={facts}
          testId="td-dep-add-after"
          candidates={after}
          placeholder="+ Add a task this blocks…"
          onAdd={(id) => void run(async () => { await commands.createEdge({ predecessorId: node.id, successorId: id }); })}
          onRemove={(e) => void run(() => commands.deleteEdge(e.id))}
          onOpenTask={onOpenTask}
        />
      </div>
    </div>
  );
}

function DepList({
  heading,
  hint,
  edges,
  other,
  facts,
  testId,
  candidates,
  placeholder,
  onAdd,
  onRemove,
  onOpenTask,
}: {
  heading: string;
  hint: string;
  edges: readonly Edge[];
  other: (e: Edge) => string;
  facts: FactContext;
  testId: string;
  candidates: Map<string, DepCandidate[]>;
  placeholder: string;
  onAdd: (taskId: string) => void;
  onRemove: (edge: Edge) => void;
  onOpenTask: (id: string) => void;
}) {
  const linked = edges.map((e) => ({ edge: e, task: facts.tree.byId.get(other(e)) })).filter((x): x is { edge: Edge; task: Node } => x.task !== undefined);
  return (
    <div className="px-td-dep">
      <div className="px-td-dep-h">{heading} <span className="px-td-note">— {hint}</span></div>
      {linked.length > 0 && (
        <ul className="px-td-dep-list">
          {linked.map(({ edge, task }) => {
            const taskDone = task.completed_at !== null;
            return (
              <li key={edge.id} className={`px-td-dep-row${taskDone ? ' px-td-dep-row--done' : ''}`} data-testid={`td-dep-${edge.id}`}>
                <span className={`px-mini-ckb${taskDone ? ' px-mini-ckb--done' : ''}`}><Ic name="check" /></span>
                <button type="button" className="px-td-dep-link" title="Open this task" onClick={() => onOpenTask(task.id)}>{task.title}</button>
                {edge.edge_type !== 'FS' && <span className="px-tag px-tag--grey" title="Dependency type">{edge.edge_type}</span>}
                <button type="button" className="px-td-ib px-td-ib--danger" aria-label={`Remove dependency on “${task.title}”`} onClick={() => onRemove(edge)}><Ic name="x" /></button>
              </li>
            );
          })}
        </ul>
      )}
      <select
        id={testId}
        className="px-td-in px-td-dep-add"
        data-testid={testId}
        aria-label={placeholder.replace(/^\+ |…$/g, '')}
        value=""
        disabled={candidates.size === 0}
        onChange={(e) => {
          if (e.target.value !== '') onAdd(e.target.value);
        }}
      >
        <option value="">{candidates.size === 0 ? 'No other open task to link' : placeholder}</option>
        {[...candidates.entries()].map(([group, list]) => (
          <optgroup key={group} label={group}>
            {list.map((c) => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
