/**
 * Review inbox (§12.1 mobile, §7.13; M14 parity): the durable conflict/rejection
 * inbox for every item_type. Items are server-owned and synced down
 * (`useReviewInbox`); the user resolves or dismisses one through the
 * `review.resolve`/`review.dismiss` commands (optimistic — it leaves the list
 * instantly and reconciles when the server confirms), exactly like web.
 */
import { useCommands, useReviewInbox, useReviewInboxHydrated, type CommandContext, type ReviewItemView } from '@prisms/ui';

import { Badge, Btn, Card, H1, Muted, Row, Screen, Skeleton, Txt } from '../ui';

/** item_type → a human, scannable label (mirrors the web inbox). */
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
  const reason = detailReason(item.detail);
  return (
    <Card testID={`review-item-${item.id}`}>
      <Row>
        <Badge>{item.severity}</Badge>
        <Txt>{item.title || (ITEM_TYPE_LABEL[item.itemType] ?? item.itemType)}</Txt>
      </Row>
      <Muted testID={`review-type-${item.id}`}>{ITEM_TYPE_LABEL[item.itemType] ?? item.itemType}</Muted>
      {reason !== null && <Muted testID={`review-reason-${item.id}`}>{reason}</Muted>}
      <Row>
        <Btn title="Resolve" variant="primary" testID={`resolve-${item.id}`} onPress={onResolve} />
        <Btn title="Dismiss" testID={`dismiss-${item.id}`} onPress={onDismiss} />
      </Row>
    </Card>
  );
}

export function Review({ ctx }: { ctx: CommandContext }) {
  const items = useReviewInbox();
  const hydrated = useReviewInboxHydrated();
  const commands = useCommands(ctx);

  return (
    <Screen testID="review">
      <H1>Review ({items.length})</H1>
      <Muted>Conflicts and rejected changes that need your attention. Resolve one once you&rsquo;ve acted on it, or dismiss it.</Muted>

      {items.length === 0 ? (
        hydrated ? (
          <Muted testID="review-empty">Nothing to review — you&rsquo;re all caught up.</Muted>
        ) : (
          <Skeleton testID="review-skeleton" />
        )
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
    </Screen>
  );
}
