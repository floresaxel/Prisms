/**
 * The marker on an Inbox capture that was completed without ever joining a
 * project — done, but with no vision behind it (`DoneTodayItem.unfocused`).
 */
export function UnfocusedTag() {
  return (
    <span className="px-tag px-tag--grey" title="Completed while unassigned, without a project — no vision behind it" data-testid="unfocused-tag">
      unfocused
    </span>
  );
}
