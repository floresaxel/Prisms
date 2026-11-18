import type { DayLogRef } from '@prisms/core';

/** Where a day-log line rolls up to — a quiet "Vision › Project" suffix. */
export function DayLogContext({ project, vision }: { project: DayLogRef | null; vision: DayLogRef | null }) {
  const label = [vision?.title, project?.title].filter((t): t is string => !!t && t.length > 0).join(' › ');
  return label ? (
    <span className="px-daylog-ctx" data-testid="daylog-ctx">
      {label}
    </span>
  ) : null;
}
