/**
 * Worklist (§1.2): available items — clock in / out, check off, delete. Reads
 * derived status from local SQLite (PowerSync reactive query → core selector);
 * every action is an optimistic local write.
 */
import { useEffect, useState } from 'react';

import { asEpochMillis, type Instant } from '@prisms/core';
import { List, ListItem, useCommands, useWorklist, type CommandContext } from '@prisms/ui';

export function Worklist({ ctx }: { ctx: CommandContext }) {
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 30_000);
    return () => clearInterval(t);
  }, []);

  const items = useWorklist(now);
  const commands = useCommands(ctx);

  return (
    <section>
      <h1>Worklist</h1>
      <p className="px-muted">Available items — clock in, check off, or delete.</p>
      <div data-testid="worklist">
        <List empty="No available tasks — everything is done or blocked.">
          {items.map((item) => (
            <ListItem
              key={item.task.id}
              leading={<span className={`px-badge px-badge--${item.status}`}>{item.status}</span>}
              trailing={
                <>
                  {item.openEntryId ? (
                    <button className="px-btn" onClick={() => void commands.clockOut(item.openEntryId!)}>Clock out</button>
                  ) : (
                    <button className="px-btn" onClick={() => void commands.clockIn(item.task.id)}>Clock in</button>
                  )}
                  <button className="px-btn px-btn--primary" onClick={() => void commands.checkOff(item.task.id)} data-testid={`check-${item.task.id}`}>
                    Done
                  </button>
                  <button className="px-btn px-btn--danger" onClick={() => void commands.softDelete(item.task.id)} aria-label="delete">×</button>
                </>
              }
            >
              {item.task.title}
            </ListItem>
          ))}
        </List>
      </div>
    </section>
  );
}
