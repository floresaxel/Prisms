/**
 * The 24 h day map (MOBILE_TODAY_PLAN §2 #12–#15) — a 14 px lane down the right
 * edge showing the *whole* day, not just the part that fits on screen.
 *
 * Everything it draws comes from `buildDayMap`: greyed hours are the complement
 * of the scheduler windows (D4), each event is a segment at its true time in
 * its project's colour, the clocked-in one pulses, and a red line marks now.
 * The expanded calendar in T3 renders the same `DayMap` at a larger scale.
 *
 * Presentational: it takes a `DayMap` and reports taps. T3 adds the drag.
 */
import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import type { GestureResponderHandlers } from 'react-native';
import type { DayMap, DayMapSegment } from '@prisms/ui';

import { theme, toneColor } from '../ui';
import { useReduceMotion } from './motion';

/** Ticks every 3 h, matching the mock — enough to read the scale, few enough to stay quiet. */
const TICK_HOURS = [3, 6, 9, 12, 15, 18, 21];

export function DayMapBar({
  map,
  onPress,
  panHandlers,
  testID,
}: {
  map: DayMap;
  onPress?: () => void;
  /** T3's drag: spread here so a leftward pull opens the day calendar. */
  panHandlers?: GestureResponderHandlers;
  testID?: string;
}) {
  const reduceMotion = useReduceMotion();
  const hasLive = map.segments.some((s) => s.state === 'live');
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!hasLive || reduceMotion) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.45, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [hasLive, reduceMotion, pulse]);

  return (
    <View
      // The pan responder owns BOTH tap and drag (see `useDayPanel`), so there
      // is no Pressable here to contend with it. Screen readers activate it
      // through `onAccessibilityTap`, which never reaches the responder.
      {...panHandlers}
      style={s.bar}
      testID={testID}
      accessible
      accessibilityRole={onPress === undefined ? 'image' : 'button'}
      accessibilityLabel={`Day map, ${map.segments.length} event${map.segments.length === 1 ? '' : 's'}`}
      accessibilityHint={onPress === undefined ? undefined : 'Drag left or tap to open the full day calendar'}
      onAccessibilityTap={onPress}
    >
      <View style={s.lane} />

      {map.inactive.map((zone) => (
        <View
          key={`inactive-${zone.topPct}`}
          pointerEvents="none"
          style={[s.inactive, { top: `${zone.topPct}%`, height: `${zone.heightPct}%` }]}
        />
      ))}

      {TICK_HOURS.map((hour) => (
        <View key={hour} pointerEvents="none" style={[s.tick, { top: `${(hour / 24) * 100}%` }]} />
      ))}

      {map.segments.map((segment) => (
        <Segment key={segment.blockId} segment={segment} pulse={pulse} />
      ))}

      {map.nowPct !== null && (
        <View pointerEvents="none" style={[s.now, { top: `${map.nowPct}%` }]} testID="day-map-now">
          <View style={s.nowKnob} />
        </View>
      )}
    </View>
  );
}

function Segment({ segment, pulse }: { segment: DayMapSegment; pulse: Animated.Value }) {
  const live = segment.state === 'live';
  const suggested = segment.state === 'suggested';

  return (
    <Animated.View
      pointerEvents="none"
      testID={`day-map-seg-${segment.blockId}`}
      style={[
        s.segment,
        { top: `${segment.topPct}%`, height: `${segment.heightPct}%` },
        live
          ? { backgroundColor: theme.live }
          : suggested
            ? // Proposed, not agreed: hollow, so it reads as lighter than a real commitment.
              { backgroundColor: theme.surface, borderWidth: 1, borderColor: toneColor[segment.tone], opacity: 0.9 }
            : { backgroundColor: toneColor[segment.tone], opacity: segment.state === 'done' ? 0.45 : 1 },
        live && { opacity: pulse },
      ]}
    />
  );
}

const s = StyleSheet.create({
  bar: { position: 'absolute', right: 9, top: 8, bottom: 8, width: 14, zIndex: 5 },
  lane: { position: 'absolute', left: 3, right: 3, top: 0, bottom: 0, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border2, borderRadius: 8 },
  inactive: { position: 'absolute', left: 4, right: 4, backgroundColor: theme.greyBg },
  tick: { position: 'absolute', left: 4, right: 4, height: 1, backgroundColor: theme.border },
  segment: { position: 'absolute', left: 4, right: 4, borderRadius: 4 },
  now: { position: 'absolute', left: 0, right: 0, height: 2.5, borderRadius: 2, backgroundColor: theme.danger },
  nowKnob: { position: 'absolute', left: -4, top: -2.2, width: 7, height: 7, borderRadius: 3.5, backgroundColor: theme.danger },
});
