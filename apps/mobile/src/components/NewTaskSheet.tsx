/**
 * The New Task sheet (MOBILE_TODAY_PLAN §2 #20–#27, D5).
 *
 * Capture is one line and a return key; everything else is optional, which the
 * dashed chips are there to say. What the chips actually choose is *how the
 * task is justified* (I1/I3), so the three submit paths are genuinely
 * different commands rather than one call with flags:
 *
 *   Project → `createTask` under it — justified, enters the worklist.
 *   Habit   → `createActivity` + `promoteActivity(habitId)` — the shipped
 *             habit-justification path.
 *   Neither → `createActivity` alone — an Inbox capture with no "why" yet,
 *             which the hint line says out loud rather than hiding.
 *
 * Due date and predecessor are follow-up commands because `node.create`
 * carries neither. Invariant failures (a cycle, a bad parent) surface through
 * the app's existing rejection banner.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { addDays, childrenOf, initialSortOrder, sortOrderBetween, type IsoDate, type Node, type TreeIndex } from '@prisms/core';
import type { HabitView, PrismsCommands, PromoteTarget, WorklistItem } from '@prisms/ui';

import { ChipPill } from './ChipPill';
import { SheetBase } from './SheetBase';
import { ActionList, type ActionRequest } from './ActionList';
import { formatDurationLong } from '../format';
import { theme } from '../ui';

/** #24: tapping the chip cycles these rather than opening a picker. */
const DURATIONS = [15, 30, 45, 60, 120];

export function NewTaskSheet({
  open,
  onClose,
  top,
  today,
  tree,
  commands,
  projects,
  habits,
  candidates,
}: {
  open: boolean;
  onClose: () => void;
  top: number;
  today: IsoDate;
  tree: TreeIndex;
  commands: PrismsCommands;
  projects: readonly PromoteTarget[];
  habits: readonly HabitView[];
  /** Tasks that can be a predecessor. */
  candidates: readonly WorklistItem[];
}) {
  const [title, setTitle] = useState('');
  const [project, setProject] = useState<PromoteTarget | null>(null);
  const [habit, setHabit] = useState<HabitView | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [dueDate, setDueDate] = useState<IsoDate | null>(null);
  const [predecessor, setPredecessor] = useState<Node | null>(null);
  const [picker, setPicker] = useState<ActionRequest | null>(null);
  const [busy, setBusy] = useState(false);

  // The sheet stays mounted while closed, so `autoFocus` — read once, at mount,
  // when `open` was still false — never fires. The wait lets the slide finish
  // before the keyboard animates in on top of it.
  const input = useRef<TextInput>(null);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => input.current?.focus(), 280);
    return () => clearTimeout(t);
  }, [open]);

  const reset = useCallback(() => {
    setTitle('');
    setProject(null);
    setHabit(null);
    setDuration(null);
    setDueDate(null);
    setPredecessor(null);
  }, []);

  /** Append after the last sibling so capture order is preserved. */
  const nextSortOrder = useCallback(
    (parentId: string | null) => {
      const siblings = parentId === null ? [] : childrenOf(tree, parentId);
      const last = siblings.at(-1)?.sort_order ?? null;
      return last === null ? initialSortOrder() : sortOrderBetween(last, null);
    },
    [tree],
  );

  const submit = useCallback(async () => {
    const text = title.trim();
    if (text === '' || busy) return;
    setBusy(true);
    try {
      let taskId: string;
      if (project !== null) {
        taskId = await commands.createTask({
          parentId: project.id,
          title: text,
          sortOrder: nextSortOrder(project.id),
          ...(duration !== null ? { estimateMinutes: duration } : {}),
        });
      } else {
        taskId = await commands.createActivity({ title: text, sortOrder: nextSortOrder(null) });
        // I3: a habit is the other way a task earns its place.
        if (habit !== null) await commands.promoteActivity(taskId, { habitId: habit.habit.id });
        if (duration !== null) await commands.setEstimate(taskId, duration);
      }
      if (dueDate !== null) await commands.setDates(taskId, { dueDate });
      if (predecessor !== null) await commands.createEdge({ predecessorId: predecessor.id, successorId: taskId });
      reset();
      onClose();
    } catch (e) {
      // Never fail silently: a rejected command otherwise looks like a dead
      // button, since the sheet just sits there.
      Alert.alert('Could not add the task', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [title, busy, project, habit, duration, dueDate, predecessor, commands, nextSortOrder, reset, onClose]);

  const dueLabel = useMemo(() => {
    if (dueDate === null) return 'Due date';
    if (dueDate === today) return 'Due today';
    if (dueDate === addDays(today, 1)) return 'Due tomorrow';
    return `Due ${dueDate.slice(5)}`;
  }, [dueDate, today]);

  const openProjectPicker = () =>
    setPicker({
      title: 'Which project?',
      message: 'A project gives the task a “why”. Without one it waits in the Inbox.',
      actions: [
        ...projects.map((p) => ({
          label: `${p.title}${p.type === 'milestone' ? ' (milestone)' : ''}`,
          onPress: () => {
            setProject(p);
            setHabit(null); // I3: a task cannot be justified by both.
          },
        })),
        ...(project !== null ? [{ label: 'Clear project', onPress: () => setProject(null) }] : []),
      ],
    });

  const openHabitPicker = () =>
    setPicker({
      title: 'Which habit?',
      message: 'A habit justifies the task instead of a project.',
      actions: [
        ...habits.map((h) => ({
          label: h.habit.title,
          onPress: () => {
            setHabit(h);
            setProject(null);
          },
        })),
        ...(habit !== null ? [{ label: 'Clear habit', onPress: () => setHabit(null) }] : []),
      ],
    });

  const openDuePicker = () =>
    setPicker({
      title: 'Due when?',
      actions: [
        { label: 'Today', onPress: () => setDueDate(today) },
        { label: 'Tomorrow', onPress: () => setDueDate(addDays(today, 1)) },
        { label: 'Next week', onPress: () => setDueDate(addDays(today, 7)) },
        ...(dueDate !== null ? [{ label: 'Clear due date', onPress: () => setDueDate(null) }] : []),
      ],
    });

  const openPredecessorPicker = () =>
    setPicker({
      title: 'Blocked by which task?',
      message: 'This task cannot start until that one is done.',
      actions: [
        ...candidates.slice(0, 40).map((c) => ({ label: c.task.title, onPress: () => setPredecessor(c.task) })),
        ...(predecessor !== null ? [{ label: 'Clear predecessor', onPress: () => setPredecessor(null) }] : []),
      ],
    });

  return (
    <>
      <SheetBase open={open} onClose={onClose} top={top} accessibilityLabel="New task" testID="new-task-sheet">
        {/* Scrolls because the sheet is anchored top..bottom: a tall keyboard on
            a short phone leaves less room than the chips and the button need. */}
        <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <TextInput
            ref={input}
            style={s.title}
            value={title}
            onChangeText={setTitle}
            placeholder="New Task"
            placeholderTextColor={theme.faint}
            selectionColor={theme.accent}
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
            testID="new-task-title"
          />

          <View style={s.row}>
            <ChipPill label={project?.title ?? 'Project'} variant="option" selected={project !== null} onPress={openProjectPicker} testID="chip-project" />
            <ChipPill label={habit?.habit.title ?? 'Habit'} variant="option" selected={habit !== null} onPress={openHabitPicker} testID="chip-habit" />
          </View>

          <View style={s.row}>
            <Text style={s.label}>Duration:</Text>
            <ChipPill
              label={duration === null ? 'Any' : formatDurationLong(duration)}
              variant="option"
              selected={duration !== null}
              onPress={() => setDuration((d) => (d === null ? DURATIONS[0]! : (DURATIONS[DURATIONS.indexOf(d) + 1] ?? null)))}
              testID="chip-duration"
            />
          </View>

          <View style={s.row}>
            <ChipPill label={dueLabel} variant="option" selected={dueDate !== null} onPress={openDuePicker} testID="chip-due" />
            <ChipPill
              label={predecessor?.title ?? 'Predecessor'}
              variant="option"
              selected={predecessor !== null}
              onPress={openPredecessorPicker}
              testID="chip-predecessor"
            />
          </View>

          <View style={s.footer}>
            <Text style={s.hint}>
              {project === null && habit === null
                ? 'No “why” yet — this waits in the Inbox. Pick a Project or Habit to put it in the worklist.'
                : 'Adds it to All Tasks.'}
            </Text>
            {/* The mock files on ↵, and that still works — but Android IMEs do not
                reliably deliver the "done" action, so the affordance is explicit. */}
            <Pressable
              onPress={() => void submit()}
              disabled={title.trim() === '' || busy}
              accessibilityRole="button"
              accessibilityLabel="Add task"
              testID="new-task-submit"
              style={({ pressed }) => [s.submit, (title.trim() === '' || busy) && s.submitDisabled, pressed && s.submitPressed]}
            >
              <Text style={s.submitText}>Add task</Text>
            </Pressable>
          </View>
        </ScrollView>
      </SheetBase>

      <ActionList request={picker} onDismiss={() => setPicker(null)} />
    </>
  );
}

const s = StyleSheet.create({
  title: { color: theme.text, fontSize: 17, fontWeight: '700', letterSpacing: -0.2, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 16, paddingBottom: 12, flexWrap: 'wrap' },
  label: { color: theme.dim, fontSize: 12.5, fontWeight: '600' },
  // Directly under the chips, NOT pushed to the bottom of the sheet: the sheet
  // is full-height, so a bottom-anchored action sits behind the keyboard.
  footer: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 18, gap: 10 },
  hint: { color: theme.faint, fontSize: 10.5, fontWeight: '600', lineHeight: 16 },
  submit: { backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  submitDisabled: { opacity: 0.4 },
  submitPressed: { backgroundColor: theme.accentDeep },
  submitText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
});
