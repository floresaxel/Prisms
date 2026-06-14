/**
 * Dashboard: server-computed aggregates with freshness, plus the vision list.
 * "New vision" is the rollback demo (§DoD): the seed already has the 4-vision
 * max (I2), so an optimistic create appears then visibly reverts when the
 * server rejects it.
 */
import { useMemo } from 'react';

import { List, ListItem, useAggregates, useCommands, useNodeTree, type CommandContext } from '@prisms/ui';

export function Dashboard({ ctx }: { ctx: CommandContext }) {
  const tree = useNodeTree();
  const aggregates = useAggregates();
  const commands = useCommands(ctx);

  const visions = useMemo(
    () => [...tree.byId.values()].filter((n) => n.node_type === 'vision').sort((a, b) => (a.sort_order < b.sort_order ? -1 : 1)),
    [tree],
  );

  return (
    <section>
      <h1>Dashboard</h1>

      <h2>Visions <span className="px-muted" data-testid="vision-count">({visions.length})</span></h2>
      <div data-testid="visions">
        <List empty="No visions yet.">
          {visions.map((v) => (
            <ListItem key={v.id}>{v.title}</ListItem>
          ))}
        </List>
      </div>
      <button className="px-btn" style={{ marginTop: 10 }} data-testid="new-vision" onClick={() => void commands.createVision('New Angle')}>
        New vision
      </button>

      <h2 style={{ marginTop: 28 }}>Computed aggregates</h2>
      <List empty="No server aggregates yet — they appear after the nightly recompute.">
        {aggregates.map((a) => (
          <ListItem
            key={`${a.subjectKind}:${a.subjectId}:${a.metric}`}
            trailing={<span className="px-badge">{a.computedBy}</span>}
          >
            {a.metric} · {a.subjectKind}
            <span className="px-muted"> · {new Date(a.computedAt).toLocaleString()}</span>
          </ListItem>
        ))}
      </List>
    </section>
  );
}
