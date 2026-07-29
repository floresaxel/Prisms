/**
 * The generated "Day log" footer on mobile (Annex L) — plain RN views over the
 * SAME `useDayLog` entries the web renders, no markdown detour.
 *
 * Inert by construction: no TextInput, no Pressable, nothing focusable, and it
 * is a sibling BELOW the editor/preview — never inside the TextInput. Times go
 * through `formatDayLogTime`, which reads the same cached Intl.DateTimeFormat as
 * `bucketDate` and touches nothing Hermes lacks.
 */
import { StyleSheet, Text, View } from 'react-native';

import { formatDayLogTime, type DayLogEntries } from '@prisms/core';

import { theme } from '../ui';

export function DayLogFooter({ entries, timezone }: { entries: DayLogEntries | null; timezone: string }) {
  if (!entries) return null;
  const { scheduled, completed, truncated } = entries;
  if (scheduled.length === 0 && completed.length === 0) return null;
  const at = (ts: string) => formatDayLogTime(ts, timezone);

  return (
    <View style={s.wrap} testID="daylog">
      <View style={s.head}>
        <Text style={s.title}>DAY LOG</Text>
        <Text style={s.caption}>Generated · updates automatically</Text>
      </View>

      {scheduled.length > 0 && (
        <View style={s.section} testID="daylog-scheduled">
          <Text style={s.label}>Scheduled</Text>
          {scheduled.map((b) => (
            <View key={b.block_id} style={s.row}>
              <View style={[s.box, b.done ? s.boxOn : null]} />
              <Text style={s.time}>{at(b.starts_at)}–{at(b.ends_at)}</Text>
              <Text style={[s.title2, b.done ? s.done : null]} numberOfLines={1}>{b.title}</Text>
            </View>
          ))}
          {truncated && truncated.scheduled > 0 && (
            <Text style={s.more} testID="daylog-sched-more">+{truncated.scheduled} more</Text>
          )}
        </View>
      )}

      {completed.length > 0 && (
        <View style={s.section} testID="daylog-completed">
          <Text style={s.label}>Completed</Text>
          {completed.map((c) => (
            <View key={c.task_id} style={s.row}>
              <Text style={s.time}>{at(c.completed_at)}</Text>
              <Text style={s.title2} numberOfLines={1}>{c.title}</Text>
              {!c.planned && <Text style={s.mark}>unplanned</Text>}
              {c.disposition === 'obsolete' && <Text style={[s.mark, s.descoped]}>descoped</Text>}
            </View>
          ))}
          {truncated && truncated.completed > 0 && (
            <Text style={s.more} testID="daylog-done-more">+{truncated.completed} more</Text>
          )}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme.border },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  title: { color: theme.dim, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  caption: { color: theme.dim, fontSize: 11 },
  section: { marginTop: 10 },
  label: { color: theme.dim, fontSize: 11, fontWeight: '600', marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
  box: { width: 12, height: 12, borderRadius: 3, borderWidth: 1.5, borderColor: theme.border },
  boxOn: { backgroundColor: theme.ok, borderColor: theme.ok },
  time: { color: theme.dim, fontSize: 11 },
  title2: { color: theme.text, fontSize: 13, flexShrink: 1 },
  done: { color: theme.dim },
  mark: { color: theme.dim, fontSize: 10, backgroundColor: theme.surface2, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 1 },
  descoped: { color: theme.accent },
  more: { color: theme.dim, fontSize: 11, marginTop: 2 },
});
