/**
 * Review inbox screen (§7.13, M10): the durable conflict/rejection inbox for
 * every `item_type` — command/dependency rejections, HLC conflicts, stale
 * suggestions, automation backstop/drift, schema-version blocks, import/sync
 * warnings. Items are server-owned and synced down (`useReviewInbox`); the user
 * opens the list and CLOSES an item (resolve or dismiss) through the
 * `review.resolve`/`review.dismiss` commands — optimistic, so a closed item
 * leaves the list instantly and reconciles when the server confirms.
 */
import { useState } from 'react';

import { Ic, ListSkeleton, useReviewInbox, useReviewInboxHydrated, useCommands, type CommandContext, type ReviewItemView } from '@prisms/ui';

type SeverityFilter = 'all' | 'error' | 'warning' | 'info';

/** item_type → a human, scannable label. */
const ITEM_TYPE_LABEL: Record<string, string> = {
  command_rejection: 'Change rejected',
  dependency_rejection: 'Dependency rejected',
  hlc_conflict: 'Edit conflict',
  stale_suggestion: 'Stale suggestion',
  automation_backstop: 'Automation filled in',
  automation_drift: 'Automation drift',
  schema_version_block: 'Update required',
  import_warning: 'Import warning',
  sync_warning: 'Sync warning',
};

/** Pull a human reason out of the item's JSON `detail`, if any. */
function detailReason(detail: string): string | null {
  if (!detail) return null;
  try {
    const d = JSON.parse(detail) as Record<string, unknown>;
    if (typeof d['reason'] === 'string' && d['reason'] !== '') return d['reason'];
    if (typeof d['reject_code'] === 'string') return String(d['reject_code']);
    return null;
  } catch {
    return detail === '""' ? null : detail;
  }
}

const SEV_ICON: Record<string, 'alert' | 'info'> = { error: 'alert', warning: 'alert', info: 'info' };

function ReviewRow({ item, onResolve, onDismiss }: { item: ReviewItemView; onResolve: () => void; onDismiss: () => void }) {
  const label = ITEM_TYPE_LABEL[item.itemType] ?? item.itemType;
  const reason = detailReason(item.detail);
  const when = item.createdAt ? new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <li className="px-trow" data-testid={`review-item-${item.id}`}>
      <span className={`px-sev px-sev--${item.severity}`} data-testid={`review-severity-${item.id}`} title={item.severity}>
        <Ic name={SEV_ICON[item.severity] ?? 'info'} />
      </span>
      <div className="px-t-main">
        <div className="px-t-title">
          {item.title || label}
          <span className="px-muted" style={{ fontWeight: 400 }} data-testid={`review-type-${item.id}`}>{label}</span>
        </div>
        {reason && <div className="px-t-meta" data-testid={`review-reason-${item.id}`}>{reason}</div>}
      </div>
      {when && <span className="px-page-sub px-num">{when}</span>}
      <button className="px-btn px-btn--sm px-btn--primary" data-testid={`resolve-${item.id}`} onClick={onResolve}>Resolve</button>
      <button className="px-btn px-btn--sm" data-testid={`dismiss-${item.id}`} onClick={onDismiss}>Dismiss</button>
    </li>
  );
}

export function Review({ ctx }: { ctx: CommandContext }) {
  const items = useReviewInbox();
  const commands = useCommands(ctx);
  const hydrated = useReviewInboxHydrated();
  const [filter, setFilter] = useState<SeverityFilter>('all');

  const counts = { error: 0, warning: 0, info: 0 };
  for (const it of items) if (it.severity in counts) counts[it.severity as keyof typeof counts] += 1;
  const shown = filter === 'all' ? items : items.filter((it) => it.severity === filter);
  const pills: { key: SeverityFilter; label: string; n: number }[] = [
    { key: 'all', label: 'All', n: items.length },
    { key: 'error', label: 'Errors', n: counts.error },
    { key: 'warning', label: 'Warnings', n: counts.warning },
    { key: 'info', label: 'Info', n: counts.info },
  ];

  return (
    <section data-testid="review-inbox">
      <div className="px-page-head">
        <h1>Review <span className="px-muted" data-testid="review-count">({items.length})</span></h1>
        <span className="px-page-sub">everything that needs a human decision — conflicts, rejections, automation notices</span>
      </div>

      <div className="px-rv-filters">
        {pills.map((p) => (
          <button key={p.key} className={`px-rv-f${filter === p.key ? ' px-rv-f--on' : ''}`} data-testid={`review-filter-${p.key}`} onClick={() => setFilter(p.key)}>
            {p.label} · {p.n}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        hydrated ? (
          <div className="px-list-empty" data-testid="review-empty">Nothing to review — you&rsquo;re all caught up.</div>
        ) : (
          <ListSkeleton />
        )
      ) : (
        <ul className="px-rows" style={{ maxWidth: 920 }} aria-busy={!hydrated || undefined}>
          {shown.map((item) => (
            <ReviewRow
              key={item.id}
              item={item}
              onResolve={() => void commands.resolveReviewItem(item.id)}
              onDismiss={() => void commands.dismissReviewItem(item.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
