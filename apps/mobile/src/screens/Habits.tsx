/**
 * Habits & skills (§12.1 mobile): daily-target progress, streaks, practice
 * hours + levels — live from core, with the running timer folded into today's
 * minutes (the meter fills during a clock-in). Check off per occurrence.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { asEpochMillis, type Instant } from '@prisms/core';
import { useCommands, useFactContext, useHabits, useHabitsHydrated, type CommandContext } from '@prisms/ui';

import { formatMinutes } from '../format';
import { Btn, Card, H1, Meter, Muted, Row, Screen, Skeleton, Txt } from '../ui';

export function Habits({ ctx }: { ctx: CommandContext }) {
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 1000);
    return () => clearInterval(t);
  }, []);

  const fact = useFactContext();
  const habits = useHabits(now);
  const commands = useCommands(ctx);
  const hydrated = useHabitsHydrated();

  return (
    <Screen testID="habits">
      <H1>Habits &amp; skills</H1>
      {habits.length === 0 &&
        (hydrated ? <Muted>No habits yet — create them on the web app.</Muted> : <Skeleton testID="habits-skeleton" />)}
      {habits.map((view) => (
        <Card key={view.habit.id} testID={`habit-${view.habit.id}`}>
          <Txt>{view.habit.title}</Txt>
          <Muted testID={`streak-${view.habit.id}`}>🔥 {view.streak.current} ({view.habit.streak_mode}, best {view.streak.longest})</Muted>
          {view.dailyTargetMinutes !== null && (
            <Row>
              <View style={{ flex: 1 }}><Meter fill={view.ringFill ?? 0} /></View>
              <Muted testID={`ring-${view.habit.id}`}>{formatMinutes(view.todayMinutes)}/{view.dailyTargetMinutes}m</Muted>
            </Row>
          )}
          {(view.habit.mastery_target_hours !== null || view.habit.level_thresholds_hours.length > 0) && (
            <Muted>
              {view.practice.hours.toFixed(1)}h
              {view.habit.level_thresholds_hours.length > 0 ? ` · L${view.practice.level}` : ''}
              {view.habit.mastery_target_hours !== null ? ` · ${Math.min(100, Math.round((view.practice.hours / view.habit.mastery_target_hours) * 100))}% to ${view.habit.mastery_target_hours}h` : ''}
            </Muted>
          )}
          <Btn
            title={view.doneToday ? 'Done ✓' : 'Check off'}
            variant="primary"
            disabled={view.doneToday}
            testID={`habit-check-${view.habit.id}`}
            onPress={() => void commands.checkOffHabit({ habitId: view.habit.id, occurrenceDate: fact.today(now) })}
          />
        </Card>
      ))}
    </Screen>
  );
}
