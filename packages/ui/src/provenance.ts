/**
 * "Why does this exist?" (§7.8, §9 history-is-explainability) — turn a row's
 * server-assigned provenance into a human explanation for tasks and schedule
 * suggestions (M9). PURE: a deterministic function of the row's provenance
 * fields, unit-tested without a browser.
 *
 * Provenance is server-assigned (R17); the optimistic client may predict
 * `source_kind='user'` + `created_by_command_id` for overlay display only.
 * Legacy rows (pre-migration) carry `source_kind='legacy'` and surface as
 * "origin unknown" — M9's stated behaviour for rows created before tracking.
 */
import type { JsonObject, SourceKind } from '@prisms/core';

/** The provenance subset every user-visible fact row carries (rows.ts maps it). */
export interface ProvenanceFields {
  source_kind: SourceKind;
  source_id: string | null;
  source_detail: JsonObject;
  created_by_command_id: string | null;
  last_modified_by_command_id: string | null;
}

export interface ProvenanceExplanation {
  /** One-line answer: who/what created this row. */
  summary: string;
  /** Supporting lines drawn from `source_detail` + command links. */
  detail: string[];
  /** True for legacy rows whose origin predates provenance tracking. */
  unknown: boolean;
}

const sd = (detail: JsonObject, key: string): string | null => {
  const v = detail[key];
  return v == null ? null : String(v);
};

/** Short command-id reference for the explanation (full ids are noisy). */
const cmdRef = (id: string | null): string | null => (id ? `command ${id.slice(0, 8)}…` : null);

/**
 * Explain a row's origin from its provenance (§7.8). `suggestionReason` is the
 * optional `schedule_blocks.suggestion_reason` (e.g. `nightly_optimization`)
 * folded into a scheduler explanation.
 */
export function explainProvenance(row: ProvenanceFields, suggestionReason?: string | null): ProvenanceExplanation {
  const detail: string[] = [];
  const created = cmdRef(row.created_by_command_id);

  switch (row.source_kind) {
    case 'user': {
      if (created) detail.push(`Created by your ${created}.`);
      return { summary: 'You created this.', detail, unknown: false };
    }
    case 'automation': {
      const trigger = sd(row.source_detail, 'trigger_node_id');
      const slot = sd(row.source_detail, 'action_slot');
      const ruleV = sd(row.source_detail, 'rule_version');
      const templateV = sd(row.source_detail, 'template_version');
      if (row.source_id) detail.push(`Automation rule ${row.source_id.slice(0, 8)}….`);
      if (trigger) detail.push(`Triggered by task ${trigger.slice(0, 8)}….`);
      if (sd(row.source_detail, 'trigger_command_id')) detail.push(`Trigger ${cmdRef(sd(row.source_detail, 'trigger_command_id'))}.`);
      if (slot !== null) detail.push(`Action slot ${slot}.`);
      if (ruleV !== null || templateV !== null) detail.push(`Rule v${ruleV ?? '?'} · template v${templateV ?? '?'}.`);
      if (row.source_detail['backstop'] === true) detail.push('Filled in by the automation backstop (a missed offline run).');
      return { summary: 'Created by an automation rule.', detail, unknown: false };
    }
    case 'scheduler': {
      if (suggestionReason) detail.push(`Reason: ${suggestionReason.replace(/_/g, ' ')}.`);
      if (row.source_id) detail.push(`Suggestion batch ${row.source_id.slice(0, 8)}….`);
      return { summary: 'Suggested by the scheduler.', detail, unknown: false };
    }
    case 'server_job':
      return { summary: 'Computed by a server job.', detail, unknown: false };
    case 'import':
      return { summary: 'Restored from an import.', detail, unknown: false };
    case 'system':
      return { summary: 'Created by the system.', detail, unknown: false };
    case 'legacy':
    default:
      return {
        summary: 'Origin unknown.',
        detail: ['This row was created before provenance tracking; its source was not recorded.'],
        unknown: true,
      };
  }
}
