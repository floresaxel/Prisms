/**
 * Dashboard (§12.1 mobile): completion bars, the priority list (decision-board
 * ranking), streak summary, and the projection with its freshness label. A
 * summary view — the full burndown chart stays on web/desktop.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { asEpochMillis, type Instant } from '@prisms/core';
import { useDashboard, useDecisionBoards, useHabits } from '@prisms/ui';

import { Card, H1, H2, Meter, Muted, Row, Screen, Txt } from '../ui';

export function Dashboard() {
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 60_000);
    return () => clearInterval(t);
  }, []);

  const data = useDashboard(now);
  const boards = useDecisionBoards();
  const habits = useHabits(now);
  const priority = boards[0]?.ranking ?? [];
  const proj = data.burndown.projection;
  const today = data.burndown.days.at(-1);

  return (
    <Screen testID="dashboard">
      <H1>Dashboard</H1>

      <Card>
        <Txt>Projected finish: {proj.projectedFinishDate ?? '—'}</Txt>
        <Muted>{Math.round(proj.dailyVelocityMinutes)} min/day burn · {today ? `${today.remainingMinutes}m remaining` : 'no data'}</Muted>
        <Muted testID="projection-freshness">{data.projectionComputedAt !== null ? `synced ${new Date(data.projectionComputedAt).toLocaleDateString()}` : 'live (client estimate)'}</Muted>
      </Card>

      <H2>Project completion</H2>
      {data.completion.length === 0 && <Muted>No projects yet.</Muted>}
      {data.completion.map(({ project, value }) => (
        <Card key={project.id}>
          <Row>
            <Txt>{project.title}</Txt>
            <Muted>{Math.round(value.percent)}%</Muted>
          </Row>
          <View><Meter fill={value.percent / 100} /></View>
        </Card>
      ))}

      <H2>Priority items</H2>
      {priority.length === 0 && <Muted>No decision board yet.</Muted>}
      {priority.map((r, i) => (
        <Card key={r.project.id} testID={`priority-${r.project.id}`}>
          <Row>
            <Txt>{i + 1}. {r.project.title}</Txt>
            <Muted>{r.priority.toFixed(1)}</Muted>
          </Row>
        </Card>
      ))}

      <H2>Streaks</H2>
      {habits.length === 0 && <Muted>No habits yet.</Muted>}
      {habits.map((h) => (
        <Card key={h.habit.id}>
          <Txt>🔥 {h.streak.current} · {h.habit.title}</Txt>
        </Card>
      ))}
    </Screen>
  );
}
