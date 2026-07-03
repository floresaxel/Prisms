/**
 * Automation-rule editor (§9): a form that builds the conditions predicate +
 * spawn-template actions JSON, validated locally by core `validateAutomationRule`
 * (E_RULE_SELF_TRIGGER / E_PARSE surfaced inline) before the optimistic write.
 * Completing/creating a matching task then spawns the templated tasks (the
 * dispatcher + backstop run the same core engine, §9.1/§9.4).
 */
import { useState } from 'react';

import { validateAutomationRule } from '@prisms/core';
import { List, ListItem, useCommands, useRules, useRulesHydrated, type CommandContext } from '@prisms/ui';

type Trigger = 'task_completed' | 'task_created';

export function Rules({ ctx }: { ctx: CommandContext }) {
  const rules = useRules();
  const commands = useCommands(ctx);
  const hydrated = useRulesHydrated();

  const [trigger, setTrigger] = useState<Trigger>('task_completed');
  const [match, setMatch] = useState('');
  const [spawnTitle, setSpawnTitle] = useState('Follow-up: {trigger.title}');
  const [estimate, setEstimate] = useState('30');
  const [toast, setToast] = useState<string | null>(null);

  function buildConditions(): unknown {
    return match.trim() === '' ? { all: [] } : { all: [{ fact: 'node.title', op: 'matches', value: match.trim() }] };
  }
  function buildActions(): unknown {
    return [
      {
        action: 'spawn_task',
        slot: 0,
        template: {
          title: spawnTitle.trim() || 'Spawned task',
          parent: 'same_as_trigger',
          ...(estimate === '' ? {} : { estimate_minutes: Number(estimate) }),
        },
      },
    ];
  }

  async function create() {
    const conditions = buildConditions();
    const actions = buildActions();
    const res = validateAutomationRule({ trigger, conditions, actions }, rules);
    if (!res.ok) {
      setToast(res.error.code);
      return;
    }
    setToast(null);
    await commands.createRule({ trigger, conditions, actions });
  }

  return (
    <section>
      <h1>Automation rules</h1>
      <p className="px-muted">When a task is created/completed and matches, spawn templated tasks (§9).</p>

      {toast && <div className="px-error" data-testid="rule-toast" onClick={() => setToast(null)}>Rejected: {toast} (click to dismiss)</div>}

      <div className="px-rule-form" data-testid="rule-form">
        <label className="px-field">Trigger
          <select className="px-select" data-testid="rule-trigger" value={trigger} onChange={(e) => setTrigger(e.target.value as Trigger)}>
            <option value="task_completed">task completed</option>
            <option value="task_created">task created</option>
          </select>
        </label>
        <label className="px-field">Title matches (blank = any)
          <input className="px-input" data-testid="rule-match" value={match} onChange={(e) => setMatch(e.target.value)} placeholder="e.g. lecture" />
        </label>
        <label className="px-field">Spawn title (supports {'{trigger.title}'})
          <input className="px-input" data-testid="rule-spawn-title" value={spawnTitle} onChange={(e) => setSpawnTitle(e.target.value)} />
        </label>
        <label className="px-field">Spawn estimate (min)
          <input className="px-input" data-testid="rule-spawn-estimate" value={estimate} onChange={(e) => setEstimate(e.target.value.replace(/[^0-9]/g, ''))} style={{ width: 120 }} />
        </label>
        <button className="px-btn px-btn--primary" data-testid="rule-add" onClick={() => void create()}>Create rule</button>
      </div>

      <div data-testid="rules" style={{ marginTop: 18 }}>
        <List empty="No automation rules yet." loading={!hydrated}>
          {rules.map((r) => (
            <ListItem
              key={r.id}
              leading={<span className={`px-badge${r.enabled ? ' px-badge--scheduled' : ''}`}>{r.enabled ? 'on' : 'off'}</span>}
              trailing={
                <>
                  <button className="px-btn" data-testid={`rule-toggle-${r.id}`} onClick={() => void commands.toggleRule(r.id, !r.enabled)}>{r.enabled ? 'Disable' : 'Enable'}</button>
                  <button className="px-btn px-btn--danger" aria-label="delete" onClick={() => void commands.deleteRule(r.id)}>×</button>
                </>
              }
            >
              <strong>{r.trigger}</strong>
              <span className="px-muted"> · {JSON.stringify(r.conditions)} → {Array.isArray(r.actions) ? `${r.actions.length} spawn(s)` : '—'}</span>
            </ListItem>
          ))}
        </List>
      </div>
    </section>
  );
}
