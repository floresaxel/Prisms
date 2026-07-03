/**
 * Kanban by date (§12.1 mobile): tap a card to select it, then tap a column to
 * re-date it (node.set_dates). Touch-friendly stand-in for the web's drag.
 */
import { useEffect, useState } from 'react';
import { Pressable } from 'react-native';

import { asEpochMillis, type Instant } from '@prisms/core';
import { useCommands, useIsHydrated, useKanban, type CommandContext } from '@prisms/ui';

import { Badge, Card, H1, Muted, Row, Screen, Skeleton, theme, Txt } from '../ui';

export function Kanban({ ctx }: { ctx: CommandContext }) {
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 60_000);
    return () => clearInterval(t);
  }, []);

  const columns = useKanban(now);
  const commands = useCommands(ctx);
  const hydrated = useIsHydrated();
  const [selected, setSelected] = useState<string | null>(null);

  async function moveTo(date: string | null) {
    if (selected === null) return;
    const id = selected;
    setSelected(null);
    await commands.setDates(id, { dueDate: date });
  }

  return (
    <Screen testID="kanban">
      <H1>Kanban</H1>
      <Muted>{selected !== null ? 'Tap a column to move the selected task.' : 'Tap a task to select it.'}</Muted>

      {!hydrated && <Skeleton testID="kanban-skeleton" rows={4} />}
      {hydrated && columns.map((col) => (
        <Card key={col.key} testID={`kanban-col-${col.key}`}>
          <Pressable onPress={() => void moveTo(col.date)} disabled={selected === null}>
            <Row>
              <Badge>{col.label}</Badge>
              <Muted>({col.cards.length})</Muted>
            </Row>
          </Pressable>
          {col.cards.map((card) => (
            <Pressable
              key={card.id}
              testID={`kanban-card-${card.id}`}
              onPress={() => setSelected(selected === card.id ? null : card.id)}
              style={{
                paddingVertical: 6,
                paddingHorizontal: 8,
                borderRadius: 8,
                marginTop: 4,
                backgroundColor: selected === card.id ? theme.surface2 : 'transparent',
                borderColor: selected === card.id ? theme.accent : theme.border,
                borderWidth: 1,
              }}
            >
              <Txt>{card.title}</Txt>
            </Pressable>
          ))}
          {col.cards.length === 0 && <Muted>—</Muted>}
        </Card>
      ))}
    </Screen>
  );
}
