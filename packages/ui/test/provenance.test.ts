/**
 * M9 — "why does this exist?" (§7.8). Proves the provenance explainer maps each
 * server-assigned `source_kind` to a human summary, folds `source_detail` into
 * the detail lines, and surfaces legacy rows as "origin unknown".
 */
import { describe, expect, it } from 'vitest';

import { explainProvenance, type ProvenanceFields } from '../src/provenance';

const base: ProvenanceFields = {
  source_kind: 'user',
  source_id: null,
  source_detail: {},
  created_by_command_id: null,
  last_modified_by_command_id: null,
};

describe('explainProvenance', () => {
  it('user-created → "You created this", with the command link', () => {
    const exp = explainProvenance({ ...base, source_kind: 'user', created_by_command_id: '0192abcd-0000-7000-8000-000000000000' });
    expect(exp.summary).toBe('You created this.');
    expect(exp.unknown).toBe(false);
    expect(exp.detail.join(' ')).toContain('0192abcd');
  });

  it('automation-spawned → names the rule, trigger, slot, and versions (§10.2)', () => {
    const exp = explainProvenance({
      ...base,
      source_kind: 'automation',
      source_id: 'rule1234-0000-7000-8000-000000000000',
      source_detail: { trigger_node_id: 'node5678-0000-7000-8000-000000000000', action_slot: 0, rule_version: 2, template_version: 1 },
    });
    expect(exp.summary).toBe('Created by an automation rule.');
    const joined = exp.detail.join(' ');
    expect(joined).toContain('rule1234');
    expect(joined).toContain('node5678');
    expect(joined).toContain('Action slot 0');
    expect(joined).toContain('Rule v2');
    expect(joined).toContain('template v1');
  });

  it('automation backstop → notes the missed offline run', () => {
    const exp = explainProvenance({ ...base, source_kind: 'automation', source_detail: { backstop: true } });
    expect(exp.detail.join(' ')).toContain('backstop');
  });

  it('scheduler suggestion → folds the suggestion reason + batch', () => {
    const exp = explainProvenance(
      { ...base, source_kind: 'scheduler', source_id: 'batch123-0000-7000-8000-000000000000' },
      'nightly_optimization',
    );
    expect(exp.summary).toBe('Suggested by the scheduler.');
    expect(exp.detail.join(' ')).toContain('nightly optimization');
    expect(exp.detail.join(' ')).toContain('batch123');
  });

  it('server_job / import / system → distinct, known summaries', () => {
    expect(explainProvenance({ ...base, source_kind: 'server_job' }).summary).toBe('Computed by a server job.');
    expect(explainProvenance({ ...base, source_kind: 'import' }).summary).toBe('Restored from an import.');
    expect(explainProvenance({ ...base, source_kind: 'system' }).summary).toBe('Created by the system.');
  });

  it('legacy → "origin unknown" (pre-migration rows)', () => {
    const exp = explainProvenance({ ...base, source_kind: 'legacy' });
    expect(exp.summary).toBe('Origin unknown.');
    expect(exp.unknown).toBe(true);
    expect(exp.detail.join(' ')).toContain('before provenance tracking');
  });
});
