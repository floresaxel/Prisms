/**
 * Review inbox screen (§7.13, M10): the durable conflict/rejection inbox for
 * every `item_type` — command/dependency rejections, HLC conflicts, stale
 * suggestions, automation backstop/drift, schema-version blocks, import/sync
 * warnings. Items are server-owned and synced down (`useReviewInbox`); the user
 * opens the list and CLOSES an item (resolve or dismiss) through the
 * `review.resolve`/`review.dismiss` commands — optimistic, so a closed item
 * leaves the list instantly and reconciles when the server confirms.
 */
import { useReviewInbox, useCommands, type CommandContext, type ReviewItemView } from '@prisms/ui';

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

/** severity → badge modifier (error/warning/info). */
const SEVERITY_CLASS: Record<string, string> = {
  error: 'px-badge--error',
  warning: 'px-badge--warning',
  info: 'px-badge--info',
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

function ReviewRow({ item, onResolve, onDismiss }: { item: ReviewItemView; onResolve: () => void; onDismiss: () => void }) {
  const label = ITEM_TYPE_LABEL[item.itemType] ?? item.itemType;
  const reason = detailReason(item.detail);
  const when = item.createdAt ? new Date(item.createdAt).toLocaleString() : '';
  return (
    <li className="px-list-item" data-testid={`review-item-${item.id}`}>
      <span className="px-list-leading">
        <span className={`px-badge ${SEVERITY_CLASS[item.severity] ?? 'px-badge--info'}`} data-testid={`review-severity-${item.id}`}>
          {item.severity}
        </span>
      </span>
      <span className="px-list-body">
        <div>
          <strong>{item.title || label}</strong>
          <span className="px-muted" style={{ marginLeft: 8 }} data-testid={`review-type-${item.id}`}>
            {label}
          </span>
        </div>
        {reason && <div className="px-muted" data-testid={`review-reason-${item.id}`}>{reason}</div>}
        {when && <div className="px-muted" style={{ fontSize: 11 }}>{when}</div>}
      </span>
      <span className="px-list-trailing">
        <button className="px-btn px-btn--primary" data-testid={`resolve-${item.id}`} onClick={onResolve}>
          Resolve
        </button>
        <button className="px-btn" data-testid={`dismiss-${item.id}`} onClick={onDismiss}>
          Dismiss
        </button>
      </span>
    </li>
  );
}

export function Review({ ctx }: { ctx: CommandContext }) {
  const items = useReviewInbox();
  const commands = useCommands(ctx);

  return (
    <section data-testid="review-inbox">
      <h1>
        Review <span className="px-muted" data-testid="review-count">({items.length})</span>
      </h1>
      <p className="px-muted">
        Conflicts and rejected changes that need your attention. Resolve one once you&rsquo;ve acted on it, or dismiss it if
        it doesn&rsquo;t matter.
      </p>

      <ul className="px-list">
        {items.length === 0 ? (
          <li className="px-list-empty" data-testid="review-empty">Nothing to review — you&rsquo;re all caught up.</li>
        ) : (
          items.map((item) => (
            <ReviewRow
              key={item.id}
              item={item}
              onResolve={() => void commands.resolveReviewItem(item.id)}
              onDismiss={() => void commands.dismissReviewItem(item.id)}
            />
          ))
        )}
      </ul>
    </section>
  );
}
