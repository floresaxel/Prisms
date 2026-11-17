/**
 * "Why does this exist?" affordance (§7.8, M9): a small toggle that explains a
 * row's server-assigned provenance — user vs automation vs scheduler — with
 * legacy rows surfacing as "origin unknown". Used on worklist tasks and agenda
 * suggestions. Pure display over `explainProvenance` (the core mapping lives in
 * @prisms/ui so mobile/desktop reuse it).
 */
import { useState } from 'react';

import { explainProvenance, Ic, type ProvenanceFields } from '@prisms/ui';

/**
 * My Day's quieter variant: nothing at all for tasks you made yourself, and a
 * bare lightning bolt for tasks an automation rule created. Hovering says
 * "Automated task"; clicking opens the same explanation as {@link WhyButton}.
 */
export function AutomatedMark({ row, testId }: { row: ProvenanceFields; testId: string }) {
  const [open, setOpen] = useState(false);
  if (row.source_kind !== 'automation') return null;
  const exp = explainProvenance(row);
  return (
    <span className="px-why">
      <button
        type="button"
        className="px-why-bolt"
        data-testid={testId}
        aria-expanded={open}
        aria-label="Automated task"
        title="Automated task"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <Ic name="zap" size={13} />
      </button>
      {open && (
        <div className="px-why-pop px-why-pop--start" role="status">
          <strong data-testid={`${testId}-summary`}>{exp.summary}</strong>
          {exp.detail.map((d, i) => (
            <div key={i} className="px-muted">
              {d}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

export function WhyButton({
  row,
  suggestionReason,
  testId,
}: {
  row: ProvenanceFields;
  suggestionReason?: string | null;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const exp = explainProvenance(row, suggestionReason);
  return (
    <span className="px-why">
      <button
        type="button"
        className="px-btn px-why-btn"
        data-testid={testId}
        aria-expanded={open}
        title="Why does this exist?"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        why?
      </button>
      {open && (
        <div className="px-why-pop" role="status">
          <strong data-testid={`${testId}-summary`}>{exp.summary}</strong>
          {exp.detail.map((d, i) => (
            <div key={i} className="px-muted">
              {d}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
