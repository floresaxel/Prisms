/**
 * Worklist (§12.1 mobile): available items — clock in/out, check off, delete,
 * with the single global running-timer (I5: clock-in disabled while one runs),
 * a clock-out → focus-review modal, progress meters and time-left. Same core
 * selectors + optimistic commands as web; React Native chrome.
 */
import { useEffect, useState } from 'react';
import { Modal, View } from 'react-native';

import { asEpochMillis, type Instant } from '@prisms/core';
import { useCommands, useDayTimeLeft, useIsHydrated, useNextBlockMinutes, useRunningTimer, useWorklist, type CommandContext } from '@prisms/ui';

import { formatElapsed, formatMinutes } from '../format';
import { Badge, Btn, Card, H1, Meter, Muted, Row, Screen, Skeleton, Txt } from '../ui';

interface ReviewTarget { entryId: string; taskId: string; taskTitle: string }
const FACTORS = [0.5, 0.75, 1.0];

export function Worklist({ ctx }: { ctx: CommandContext }) {
  const [now, setNow] = useState<Instant>(asEpochMillis(Date.now()));
  useEffect(() => {
    const t = setInterval(() => setNow(asEpochMillis(Date.now())), 1000);
    return () => clearInterval(t);
  }, []);

  const items = useWorklist(now);
  const running = useRunningTimer(now);
  const dayLeft = useDayTimeLeft(now);
  const nextBlock = useNextBlockMinutes(now);
  const commands = useCommands(ctx);
  const hydrated = useIsHydrated();

  const [review, setReview] = useState<ReviewTarget | null>(null);
  const [focus, setFocus] = useState(1.0);
  const [completed, setCompleted] = useState(false);

  async function clockOut(entryId: string, taskId: string, taskTitle: string) {
    await commands.clockOut(entryId);
    setFocus(1.0);
    setCompleted(false);
    setReview({ entryId, taskId, taskTitle });
  }

  async function submitReview() {
    if (review === null) return;
    await commands.review({ entryId: review.entryId, focusFactor: focus, completedSession: completed, taskId: review.taskId });
    setReview(null);
  }

  return (
    <Screen testID="worklist">
      <H1>Worklist</H1>
      <Muted testID="day-left">
        {formatMinutes(dayLeft)} left today{nextBlock !== null ? ` · next block in ${formatMinutes(nextBlock)}` : ''}
      </Muted>

      {running !== null && (
        <Card testID="running-timer">
          <Row>
            <Badge>running</Badge>
            <Txt>{running.task?.title ?? 'Task'}</Txt>
          </Row>
          <Row>
            <Txt testID="timer-elapsed">{formatElapsed(running.elapsedMs)}</Txt>
            <Btn title="Clock out" testID="timer-clock-out" onPress={() => void clockOut(running.entry.id, running.entry.task_id, running.task?.title ?? 'task')} />
          </Row>
        </Card>
      )}

      {items.length === 0 &&
        (hydrated ? <Muted>No available tasks — everything is done or blocked.</Muted> : <Skeleton testID="worklist-skeleton" />)}
      {items.map((item) => (
        <Card key={item.task.id} testID={`task-${item.task.id}`}>
          <Row>
            <Badge>{item.status}</Badge>
            <Txt>{item.task.title}</Txt>
          </Row>
          {item.progress.estimateMinutes !== null && (
            <Row>
              <View style={{ flex: 1 }}><Meter fill={item.progress.ratio ?? 0} /></View>
              <Muted testID={`progress-pct-${item.task.id}`}>{Math.round((item.progress.ratio ?? 0) * 100)}%</Muted>
            </Row>
          )}
          {item.minutesLeftInTask !== null && <Muted>{formatMinutes(item.minutesLeftInTask)} left</Muted>}
          <Row>
            {item.openEntryId !== undefined ? (
              <Btn title="Clock out" onPress={() => void clockOut(item.openEntryId as string, item.task.id, item.task.title)} />
            ) : (
              <Btn title="Clock in" testID={`clock-in-${item.task.id}`} disabled={running !== null} onPress={() => void commands.clockIn(item.task.id)} />
            )}
            <Btn title="Done" variant="primary" testID={`check-${item.task.id}`} onPress={() => void commands.checkOff(item.task.id)} />
            <Btn title="✕" variant="danger" testID={`delete-${item.task.id}`} onPress={() => void commands.softDelete(item.task.id)} />
          </Row>
        </Card>
      ))}

      <Modal visible={review !== null} transparent animationType="fade" onRequestClose={() => setReview(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 24 }}>
          <Card testID="review-modal">
            <H1>Session review</H1>
            <Muted>{review?.taskTitle}</Muted>
            <Txt>Focus factor: ×{focus.toFixed(2)}</Txt>
            <Row>
              {FACTORS.map((f) => (
                <Btn key={f} title={`×${f.toFixed(2)}`} variant={focus === f ? 'primary' : 'default'} testID={`review-focus-${f}`} onPress={() => setFocus(f)} />
              ))}
            </Row>
            <Btn title={completed ? 'Completed ✓' : 'Mark completed'} variant={completed ? 'primary' : 'default'} testID="review-completed" onPress={() => setCompleted((c) => !c)} />
            <Row>
              <Btn title="Skip" onPress={() => setReview(null)} />
              <Btn title="Save" variant="primary" testID="review-save" onPress={() => void submitReview()} />
            </Row>
          </Card>
        </View>
      </Modal>
    </Screen>
  );
}
