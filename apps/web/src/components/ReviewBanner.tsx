/**
 * Review-inbox surfaces above the screens (§7.13, M9):
 *   - a prominent `schema_version_block` upgrade prompt (this device is too old
 *     to sync some changes — the server rejected them with `client_too_old`),
 *   - a lightweight "N items need review" pointer for every other open item
 *     (command/dependency rejections, stale suggestions, drift, …). The full
 *     open/resolve/dismiss inbox screen is M10; this just points at it.
 *
 * Driven by the synced, server-owned `sync_review_items` (`useReviewInbox`);
 * the client never writes these — a rejection drops the overlay and the item
 * arrives via sync.
 */
import { useReviewInbox } from '@prisms/ui';

const SCHEMA_BLOCK = 'schema_version_block';

export function ReviewBanner() {
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
        <div className="px-banner" data-testid="review-banner" role="status">
          {others.length} item{others.length > 1 ? 's' : ''} need review.
        </div>
      )}
    </>
  );
}
