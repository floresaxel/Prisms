/**
 * A small notebook icon that marks a task which has details (its description).
 * It sits right after the task's title in every list that shows tasks, and renders
 * nothing when the details are empty. The row it sits in opens the card on click,
 * so the mark is not a control — hovering it only names it.
 */
import { Ic } from '@prisms/ui';

export function DetailsMark({ node }: { node: { id: string; description: string } }) {
  if (node.description.trim() === '') return null;
  return (
    <span className="px-t-hasnote" data-testid={`has-details-${node.id}`}>
      <Ic name="notebook" title="Has details" />
    </span>
  );
}
