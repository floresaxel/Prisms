/**
 * Blocker-rule editor (§9.2): builds a single-condition predicate (shared AST
 * with automations) over an all-tasks scope. Enabled blockers make matching
 * tasks `blocked` via the status function — instantly and offline.
 */
import { useState } from 'react';

import { asEpochMillis, type Instant } from '@prisms/core';
import { useBlockedTasks, useBlockers, useCommands, useIsHydrated, type CommandContext } from '@prisms/ui';

const FACTS = [
  { fact: 'weather.precip_prob', label: 'weather: rain probability', op: 'gt', value: '0.6' },
  { fact: 'graph.unfinished_predecessors', label: 'graph: unfinished predecessors', op: 'gt', value: '0' },
  { fact: 'project.phase', label: 'project phase is', op: 'eq', value: 'planned' },
  { fact: 'node.title', label: 'title matches', op: 'matches', value: '' },
] as const;

export function Blockers({ ctx }: { ctx: CommandContext }) {
  const [now] = useState<Instant>(() => asEpochMillis(Date.now()));
  const blockers = useBlockers();
  const blockedTasks = useBlockedTasks(now);
  const commands = useCommands(ctx);
  const hydrated = useIsHydrated();

  const [label, setLabel] = useState('');
  const [factIdx, setFactIdx] = useState(0);
  const [value, setValue] = useState<string>(FACTS[0].value);

  const spec = FACTS[factIdx]!;

  async function create() {
    if (label.trim() === '') return;
    const raw = value.trim();
    const coerced = spec.op === 'gt' ? Number(raw) : raw;
    const predicate = { all: [{ fact: spec.fact, op: spec.op, value: coerced }] };
    await commands.createBlocker({ scope: {}, predicate, label: label.trim() });
    setLabel('');
  }

  return (
    <section>
      <p className="px-muted" style={{ marginTop: 0 }}>Dynamic blockers driven by graph position, phase, or title (§9.2). Scope: all tasks.</p>

      <div className="px-rule-form" data-testid="blocker-form">
        <label className="px-field">Label
          <input className="px-input" data-testid="blocker-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Blocked: rain forecast" />
        </label>
        <label className="px-field">Condition
          <select className="px-select" data-testid="blocker-fact" value={factIdx} onChange={(e) => { setFactIdx(Number(e.target.value)); setValue(FACTS[Number(e.target.value)]!.value); }}>
            {FACTS.map((f, i) => <option key={f.fact} value={i}>{f.label} ({f.op})</option>)}
          </select>
        </label>
        <label className="px-field">Value
          <input className="px-input" data-testid="blocker-value" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <button className="px-btn px-btn--primary" data-testid="blocker-add" onClick={() => void create()}>Create blocker</button>
      </div>

      <div className="px-rows" data-testid="blockers" style={{ marginTop: 14, maxWidth: 760 }}>
        {blockers.length === 0 && <div className="px-trow px-muted">{hydrated ? 'No blocker rules yet.' : 'Loading…'}</div>}
        {blockers.map((b) => {
          const impact = b.enabled ? blockedTasks.filter((t) => t.blockedBy.includes(b.label)).length : 0;
          return (
            <div className="px-rule" key={b.id}>
              <button
                className={`px-toggle${b.enabled ? ' px-toggle--on' : ''}`}
                data-testid={`blocker-toggle-${b.id}`}
                aria-label={b.enabled ? 'disable blocker' : 'enable blocker'}
                onClick={() => void commands.toggleBlocker(b.id, !b.enabled)}
              />
              <div className="px-rule-body">
                <div className="px-rule-name">{b.label}</div>
                <div className="px-flow">
                  <span className="px-flow-step">blocks a task when</span>
                  <span className="px-flow-arr">→</span>
                  <span className="px-flow-step"><code>{JSON.stringify(b.predicate)}</code></span>
                </div>
                <div className="px-rule-impact" data-testid={`blocker-impact-${b.id}`}>
                  {b.enabled ? `Currently blocking ${impact} task${impact === 1 ? '' : 's'}.` : 'Disabled — blocking nothing.'}
                </div>
              </div>
              <button className="px-btn px-btn--sm px-btn--danger" aria-label="delete" onClick={() => void commands.deleteBlocker(b.id)}>×</button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
