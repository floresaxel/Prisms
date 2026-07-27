/**
 * The swipe-out day calendar (MOBILE_TODAY_PLAN §2 #16–#17, T3).
 *
 * The same `DayMap` the 14 px bar draws, at a scale where blocks can carry
 * labels: an hour grid, the greyed non-scheduling hours, each block in its
 * project's tint, and the now-line with a time. Because both surfaces render
 * one selector, a block cannot be amber here and blue there.
 *
 * Suggested blocks are the reason this panel is more than a bigger bar — it is
 * where a proposal becomes a commitment (§7.5 accept) or goes away (reject).
 */
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { DayMap, DayMapSegment } from '@prisms/ui';

import { formatDurationLong } from '../format';
import { theme, toneTint } from '../ui';
import { DAY_PANEL_WIDTH, type DayPanelController } from './useDayPanel';

const GRID_HEIGHT = 24 * 46; // 46 px per hour — a 30-min block stays legible
const LABEL_HOURS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

export function DayPanel({
  map,
  heading,
  controller,
  onAccept,
  onReject,
}: {
  map: DayMap;
  /** e.g. `Sunday` — the day being shown. */
  heading: string;
  controller: DayPanelController;
  onAccept: (blockId: string) => void;
  onReject: (blockId: string) => void;
}) {
  const { open, close, translateX, scrimOpacity, panelOpacity, panelPanHandlers } = controller;
  // The panel spans the full height, so its own header sits under the status
  // bar unless it takes the inset.
  const insets = useSafeAreaInsets();

  return (
    <>
      <Animated.View
        pointerEvents={open ? 'auto' : 'none'}
        style={[s.scrim, { opacity: scrimOpacity }]}
        testID="day-panel-scrim"
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityRole="button" accessibilityLabel="Close day calendar" />
      </Animated.View>

      <Animated.View
        {...panelPanHandlers}
        pointerEvents={open ? 'auto' : 'none'}
        accessibilityViewIsModal={open}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? 'yes' : 'no-hide-descendants'}
        testID="day-panel"
        style={[s.panel, { opacity: panelOpacity, transform: [{ translateX }] }]}
      >
        <View style={s.grab} />

        <View style={[s.header, { paddingTop: insets.top + 14 }]}>
          <Text style={s.headerDay}>{heading}</Text>
          <Text style={s.headerMeta}>{activeLabel(map)}</Text>
        </View>

        <ScrollView contentContainerStyle={s.trackWrap} showsVerticalScrollIndicator={false}>
          <View style={s.track}>
            {LABEL_HOURS.map((hour) => (
              <View key={hour} style={[s.hourRow, { top: (hour / 24) * GRID_HEIGHT }]} pointerEvents="none">
                <Text style={s.hourLabel}>{hour}:00</Text>
                <View style={s.hourLine} />
              </View>
            ))}

            {map.inactive.map((zone) => (
              <View
                key={`inactive-${zone.topPct}`}
                pointerEvents="none"
                style={[s.inactive, { top: (zone.topPct / 100) * GRID_HEIGHT, height: (zone.heightPct / 100) * GRID_HEIGHT }]}
              />
            ))}

            {map.segments.map((segment) => (
              <Block key={segment.blockId} segment={segment} onAccept={onAccept} onReject={onReject} />
            ))}

            {map.nowPct !== null && (
              <View style={[s.now, { top: (map.nowPct / 100) * GRID_HEIGHT }]} pointerEvents="none" testID="day-panel-now">
                <Text style={s.nowLabel}>{minutesLabel(Math.round((map.nowPct / 100) * 1440))}</Text>
                <View style={s.nowLine} />
                <View style={s.nowKnob} />
              </View>
            )}
          </View>
        </ScrollView>
      </Animated.View>
    </>
  );
}

function Block({
  segment,
  onAccept,
  onReject,
}: {
  segment: DayMapSegment;
  onAccept: (blockId: string) => void;
  onReject: (blockId: string) => void;
}) {
  const tint = toneTint[segment.tone];
  const top = (segment.startMin / 1440) * GRID_HEIGHT;
  const height = Math.max(16, ((segment.endMin - segment.startMin) / 1440) * GRID_HEIGHT - 3);
  const done = segment.state === 'done';
  const live = segment.state === 'live';
  const suggested = segment.state === 'suggested';

  const box = done
    ? { backgroundColor: theme.accent, borderColor: theme.accent }
    : live
      ? { backgroundColor: theme.surface, borderColor: theme.live, borderWidth: 2 }
      : suggested
        ? { backgroundColor: theme.surface, borderColor: tint.border, borderStyle: 'dashed' as const }
        : { backgroundColor: tint.bg, borderColor: tint.border };
  const textColor = done ? '#ffffff' : live ? '#a3580a' : tint.text;

  return (
    <View style={[s.block, box, { top, height }]} testID={`day-panel-block-${segment.blockId}`}>
      <Text style={[s.blockTitle, { color: textColor }, done && s.blockTitleDone]} numberOfLines={1}>
        {segment.anchored ? '🔒 ' : ''}
        {segment.title}
      </Text>

      {suggested ? (
        <View style={s.suggestRow}>
          <Pressable
            onPress={() => onAccept(segment.blockId)}
            accessibilityRole="button"
            accessibilityLabel={`Accept ${segment.title}`}
            testID={`day-panel-accept-${segment.blockId}`}
            style={[s.suggestBtn, s.suggestAccept]}
          >
            <Text style={s.suggestAcceptText}>Accept</Text>
          </Pressable>
          <Pressable
            onPress={() => onReject(segment.blockId)}
            accessibilityRole="button"
            accessibilityLabel={`Reject ${segment.title}`}
            testID={`day-panel-reject-${segment.blockId}`}
            style={s.suggestBtn}
          >
            <Text style={s.suggestRejectText}>Reject</Text>
          </Pressable>
        </View>
      ) : (
        height >= 28 && (
          <Text style={[s.blockMeta, { color: textColor }]} numberOfLines={1}>
            {done
              ? `✓ ${formatDurationLong(segment.loggedMinutes)}`
              : `${formatDurationLong(segment.endMin - segment.startMin)}${live ? '' : ' est.'} · until ${minutesLabel(segment.endMin)}`}
          </Text>
        )
      )}
    </View>
  );
}

/** `active 8:00–20:00`, or an honest summary when the windows are not one block. */
function activeLabel(map: DayMap): string {
  if (map.active.length === 0) return '24 hrs · no active hours';
  if (map.active.length === 1) {
    const only = map.active[0]!;
    if (only.startMin === 0 && only.endMin >= 1440) return '24 hrs · active all day';
    return `24 hrs · active ${minutesLabel(only.startMin)}–${minutesLabel(only.endMin)}`;
  }
  return `24 hrs · ${map.active.length} active windows`;
}

function minutesLabel(min: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.round(min)));
  return `${Math.floor(clamped / 60)}:${String(clamped % 60).padStart(2, '0')}`;
}

const s = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.scrim, zIndex: 7 },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: DAY_PANEL_WIDTH,
    zIndex: 8,
    backgroundColor: theme.surface,
    borderLeftWidth: 1,
    borderLeftColor: theme.border,
    shadowColor: '#101828',
    shadowOffset: { width: -14, height: 0 },
    shadowOpacity: 0.16,
    shadowRadius: 34,
    elevation: 18,
  },
  grab: { position: 'absolute', left: 5, top: '50%', width: 4, height: 44, borderRadius: 2, backgroundColor: theme.border2 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: theme.border },
  headerDay: { color: theme.text, fontSize: 13.5, fontWeight: '800', letterSpacing: -0.2 },
  headerMeta: { color: theme.faint, fontSize: 10, fontWeight: '600', marginLeft: 'auto' },

  trackWrap: { paddingTop: 10, paddingBottom: 20, paddingRight: 6 },
  track: { height: GRID_HEIGHT, marginLeft: 4 },
  hourRow: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center' },
  hourLabel: { width: 34, textAlign: 'right', color: theme.faint, fontSize: 9, fontWeight: '600' },
  hourLine: { flex: 1, height: 1, backgroundColor: theme.border, marginLeft: 6 },
  inactive: { position: 'absolute', left: 40, right: 0, backgroundColor: '#eff2f6', borderRadius: 7 },

  block: { position: 'absolute', left: 44, right: 2, borderRadius: 9, borderWidth: 1.5, paddingHorizontal: 8, paddingVertical: 3, overflow: 'hidden' },
  blockTitle: { fontSize: 11, fontWeight: '700', letterSpacing: -0.1 },
  blockTitleDone: { textDecorationLine: 'line-through' },
  blockMeta: { fontSize: 9, fontWeight: '600', opacity: 0.85, marginTop: 1 },

  suggestRow: { flexDirection: 'row', gap: 6, marginTop: 3 },
  suggestBtn: { borderWidth: 1, borderColor: theme.border2, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, backgroundColor: theme.surface },
  suggestAccept: { borderColor: theme.accent, backgroundColor: theme.accent },
  suggestAcceptText: { color: '#ffffff', fontSize: 9, fontWeight: '700' },
  suggestRejectText: { color: theme.dim, fontSize: 9, fontWeight: '700' },

  now: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', zIndex: 3 },
  nowLabel: { width: 34, textAlign: 'right', color: theme.danger, fontSize: 8.5, fontWeight: '800' },
  nowLine: { flex: 1, height: 2, backgroundColor: theme.danger, marginLeft: 6 },
  nowKnob: { position: 'absolute', left: 36, width: 8, height: 8, borderRadius: 4, backgroundColor: theme.danger },
});
