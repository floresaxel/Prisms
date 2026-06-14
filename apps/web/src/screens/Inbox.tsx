/**
 * Activity inbox (§1.2): a parentless holding area for quick captures. An
 * activity has no justification (I3 exempt) and so never appears in the
 * worklist; promoting it attaches a parent project/milestone (I1) and turns it
 * into a real task. Both create and promote are optimistic local writes.
 */
import { useState } from 'react';

import { initialSortOrder, sortOrderBetween, type Node } from '@prisms/core';
import {
  List,
  ListItem,
  useActivityInbox,
  useCommands,
  usePromoteTargets,
  type CommandContext,
  type PromoteTarget,
} from '@prisms/ui';

function InboxRow({
  activity,
  targets,
  onPromote,
  onDelete,
}: {
  activity: Node;
  targets: PromoteTarget[];
  onPromote: (id: string, parentId: string) => void;
  onDelete: (id: string) => void;
}) {
  const [parentId, setParentId] = useState('');
  const selected = parentId || targets[0]?.id || '';
  return (
    <ListItem
      trailing={
        <>
          <select
            className="px-select"
            value={selected}
            data-testid={`promote-target-${activity.id}`}
            onChange={(e) => setParentId(e.target.value)}
            disabled={targets.length === 0}
          >
            {targets.length === 0 && <option value="">No project to promote into</option>}
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title} ({t.type})
              </option>
            ))}
          </select>
          <button
            className="px-btn px-btn--primary"
            data-testid={`promote-${activity.id}`}
            disabled={selected === ''}
            onClick={() => onPromote(activity.id, selected)}
          >
            Promote
          </button>
          <button className="px-btn px-btn--danger" aria-label="delete" onClick={() => onDelete(activity.id)}>×</button>
        </>
      }
    >
      {activity.title}
    </ListItem>
  );
}

export function Inbox({ ctx }: { ctx: CommandContext }) {
  const activities = useActivityInbox();
  const targets = usePromoteTargets();
  const commands = useCommands(ctx);
  const [title, setTitle] = useState('');

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = title.trim();
    if (trimmed === '') return;
    const last = activities.at(-1)?.sort_order ?? null;
    const sortOrder = last === null ? initialSortOrder() : sortOrderBetween(last, null);
    await commands.createActivity({ title: trimmed, sortOrder });
    setTitle('');
  }

  return (
    <section>
      <h1>Inbox</h1>
      <p className="px-muted">Capture anything; promote it into a project to make it a real task.</p>

      <form onSubmit={add} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          className="px-input"
          placeholder="Add to inbox…"
          value={title}
          data-testid="activity-title"
          onChange={(e) => setTitle(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="px-btn px-btn--primary" type="submit" data-testid="activity-add">Add</button>
      </form>

      <div data-testid="inbox">
        <List empty="Inbox is empty.">
          {activities.map((activity) => (
            <InboxRow
              key={activity.id}
              activity={activity}
              targets={targets}
              onPromote={(id, parentId) => void commands.promoteActivity(id, { parentId })}
              onDelete={(id) => void commands.softDelete(id)}
            />
          ))}
        </List>
      </div>
    </section>
  );
}
