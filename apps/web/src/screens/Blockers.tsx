/**
 * Blocker-rule editor (§9.2): builds a single-condition predicate (shared AST
 * with automations) over an all-tasks scope. Enabled blockers make matching
 * tasks `blocked` via the status function — instantly and offline.
 */
import { useState } from 'react';

import { List, ListItem, useBlockers, useCommands, type CommandContext } from '@prisms/ui';

const FACTS = [
  { fact: 'weather.precip_prob', label: 'weather: rain probability', op: 'gt', value: '0.6' },
  { fact: 'graph.unfinished_predecessors', label: 'graph: unfinished predecessors', op: 'gt', value: '0' },
  { fact: 'project.phase', label: 'project phase is', op: 'eq', value: 'planned' },
  { fact: 'node.title', label: 'title matches', op: 'matches', value: '' },
] as const;

export function Blockers({ ctx }: { ctx: CommandContext }) {
  const blockers = useBlockers();
  const commands = useCommands(ctx);

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
      <h1>Blocker rules</h1>
      <p className="px-muted">Dynamic blockers driven by weather, graph position, phase, or title (§9.2). Scope: all tasks.</p>

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

      <div data-testid="blockers" style={{ marginTop: 18 }}>
        <List empty="No blocker rules yet.">
          {blockers.map((b) => (
            <ListItem
              key={b.id}
              leading={<span className={`px-badge${b.enabled ? ' px-badge--blocked' : ''}`}>{b.enabled ? 'on' : 'off'}</span>}
              trailing={
                <>
                  <button className="px-btn" data-testid={`blocker-toggle-${b.id}`} onClick={() => void commands.toggleBlocker(b.id, !b.enabled)}>{b.enabled ? 'Disable' : 'Enable'}</button>
                  <button className="px-btn px-btn--danger" aria-label="delete" onClick={() => void commands.deleteBlocker(b.id)}>×</button>
                </>
              }
            >
              <strong>{b.label}</strong>
              <span className="px-muted"> · {JSON.stringify(b.predicate)}</span>
            </ListItem>
          ))}
        </List>
      </div>
    </section>
  );
}
