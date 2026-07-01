/**
 * Review-inbox surfaces above the screens (§7.13, M9/M10):
 *   - a prominent `schema_version_block` upgrade prompt (this device is too old
 *     to sync some changes — the server rejected them with `client_too_old`),
 *   - a lightweight "N items need review" pointer for every other open item
 *     (command/dependency rejections, stale suggestions, drift, …). It links to
 *     the full open/resolve/dismiss inbox screen (M10) via `onOpen`.
 *
 * Driven by the synced, server-owned `sync_review_items` (`useReviewInbox`);
 * the client never creates these — a rejection drops the overlay and the item
 * arrives via sync — and closes them only through the review commands (M10).
 */
import { useReviewInbox } from '@prisms/ui';

const SCHEMA_BLOCK = 'schema_version_block';

export function ReviewBanner({ onOpen }: { onOpen?: () => void }) {
  const items = useReviewInbox();
  const upgrade = items.filter((i) => i.itemType === SCHEMA_BLOCK);
  const others = items.filter((i) => i.itemType !== SCHEMA_BLOCK);

  if (items.length === 0) return null;

  return (
    <>
      {upgrade.length > 0 && (
        <div className="px-banner px-banner--upgrade" data-testid="schema-upgrade-banner" role="alert">
          <strong>Update required.</strong> This device&rsquo;s app version is too old to sync some changes
          {upgrade.length > 1 ? ` (${upgrade.length} blocked)` : ''}. Update Prisms to continue syncing.
        </div>
      )}
      {others.length > 0 && (
        <div
          className="px-banner"
          data-testid="review-banner"
          role={onOpen ? 'button' : 'status'}
          onClick={onOpen}
          style={onOpen ? { cursor: 'pointer' } : undefined}
        >
          {others.length} item{others.length > 1 ? 's' : ''} need review.{onOpen ? ' Open the review inbox →' : ''}
        </div>
      )}
    </>
  );
}
