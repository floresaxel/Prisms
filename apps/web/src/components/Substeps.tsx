/**
 * A task's checklist steps under its row (W3 task_steps): the row's bubble
 * toggle ("+ Step" / "2/3 steps") expands and collapses the panel, where steps
 * are added on Enter, ticked and renamed in place. Tasks shows the toggle on
 * every unblocked task; My Day only on tasks that already have steps.
 *
 * Testids: steps-toggle-<taskId>, substeps-<taskId>, step-add-<taskId>,
 * step-toggle-<stepId>, step-rename-<stepId>, step-rename-input-<stepId>.
 */
import { useState } from 'react';

import { initialSortOrder, sortOrderBetween, type TaskStep } from '@prisms/core';
import { Ic, type PrismsCommands } from '@prisms/ui';

export function stepsLabel(steps: readonly TaskStep[]): string {
  if (steps.length === 0) return '+ Step';
  const doneCount = steps.filter((s) => s.done).length;
  const noun = steps.length === 1 ? 'step' : 'steps';
  return doneCount > 0 ? `${doneCount}/${steps.length} ${noun}` : `${steps.length} ${noun}`;
}

/** The bubble that expands / collapses a row's steps. A button, so a click on it never opens the details card. */
export function StepsToggle({ taskId, steps, open, onToggle }: { taskId: string; steps: readonly TaskStep[]; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`px-steps-tg${open ? ' px-steps-tg--open' : ''}`}
      data-testid={`steps-toggle-${taskId}`}
      aria-expanded={open}
      aria-controls={`substeps-${taskId}`}
      title={open ? 'Hide steps' : steps.length === 0 ? 'Add steps' : 'Show steps'}
      onClick={onToggle}
    >
      {stepsLabel(steps)}
    </button>
  );
}

export function SubstepPanel({ taskId, steps, commands }: { taskId: string; steps: readonly TaskStep[]; commands: PrismsCommands }) {
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
    <div className="px-substeps" id={`substeps-${taskId}`} data-testid={`substeps-${taskId}`}>
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
