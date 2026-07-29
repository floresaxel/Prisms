/**
 * The itinerary marker (MOBILE_TODAY_PLAN §2 #7–#9). Every row gets the *same*
 * 14 px dot — only its colour and state differ, so the eye reads the column as
 * one timeline rather than a legend of shapes:
 *
 *   • tone      → the parent project's colour (`projectTone`, shared with web)
 *   • checked   → accent fill + ✓, tappable to un-do
 *   • pulse     → a clocked-in task: the dot breathes and throws a ring
 *
 * Presentational only — the caller owns what a press means.
 */
import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import type { DotTone } from '@prisms/ui';

import { theme, toneColor } from '../ui';
import { useReduceMotion } from './motion';

const SIZE = 14;
const RING_SCALE = 2.4;

export function Dot({
  tone = 'grey',
  checked = false,
  pulse = false,
  onPress,
  accessibilityLabel,
  testID,
}: {
  tone?: DotTone | 'grey';
  checked?: boolean;
  pulse?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const reduceMotion = useReduceMotion();
  const animate = pulse && !reduceMotion;
  const beat = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!animate) {
      beat.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(beat, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [animate, beat]);

  const color = checked ? theme.accent : pulse ? theme.live : toneColor[tone];

  const dot = (
    <View style={s.slot} testID={testID}>
      {animate && (
        <Animated.View
          pointerEvents="none"
          style={[
            s.ring,
            {
              backgroundColor: color,
              opacity: beat.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
              transform: [{ scale: beat.interpolate({ inputRange: [0, 1], outputRange: [1, RING_SCALE] }) }],
            },
          ]}
        />
      )}
      <Animated.View
        style={[
          s.dot,
          { backgroundColor: color },
          animate && { opacity: beat.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.5, 1] }) },
        ]}
      >
        {checked && <Text style={s.check}>✓</Text>}
      </Animated.View>
    </View>
  );

  if (onPress === undefined) {
    return accessibilityLabel === undefined ? (
      dot
    ) : (
      <View accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel}>
        {dot}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => pressed && s.pressed}
    >
      {dot}
    </Pressable>
  );
}

const s = StyleSheet.create({
  slot: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  dot: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: SIZE, height: SIZE, borderRadius: SIZE / 2 },
  check: { color: '#ffffff', fontSize: 9, fontWeight: '900', lineHeight: 11 },
  pressed: { opacity: 0.6 },
});
