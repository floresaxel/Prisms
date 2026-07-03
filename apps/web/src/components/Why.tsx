/**
 * "Why does this exist?" affordance (§7.8, M9): a small toggle that explains a
 * row's server-assigned provenance — user vs automation vs scheduler — with
 * legacy rows surfacing as "origin unknown". Used on worklist tasks and agenda
 * suggestions. Pure display over `explainProvenance` (the core mapping lives in
 * @prisms/ui so mobile/desktop reuse it).
 */
import { useState } from 'react';

import { explainProvenance, type ProvenanceFields } from '@prisms/ui';

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
