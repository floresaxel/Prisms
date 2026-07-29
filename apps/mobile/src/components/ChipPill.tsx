/**
 * The small rounded pill the mock uses twice (MOBILE_TODAY_PLAN §2 #5, #21–#26):
 *
 *   • `category` — a read-only tag on an itinerary row (HEALTH, HABIT…)
 *   • `option`   — a dashed property chip in the new-task sheet; dashed reads
 *                  as "optional, not set yet", solid+accent as chosen
 *
 * Presentational only: what a chip *means* is the caller's business.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../ui';

export function ChipPill({
  label,
  variant = 'category',
  selected = false,
  onPress,
  testID,
}: {
  label: string;
  variant?: 'category' | 'option';
  selected?: boolean;
  onPress?: () => void;
  testID?: string;
}) {
  const option = variant === 'option';
  const box = [s.base, option ? s.option : s.category, option && !selected && s.dashed, selected && s.selected];
  const text = [s.label, option ? s.optionLabel : s.categoryLabel, selected && s.selectedLabel];

  if (onPress === undefined) {
    return (
      <View style={box} testID={testID}>
        <Text style={text}>{label}</Text>
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => [box, pressed && s.pressed]}
    >
      <Text style={text}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  base: { alignSelf: 'flex-start', borderWidth: 1.5, backgroundColor: theme.surface, borderColor: theme.border2 },
  category: { borderRadius: 20, paddingHorizontal: 9, paddingVertical: 2 },
  option: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: 'transparent' },
  // Android renders a rounded dashed border as solid; set/unset also differs by
  // colour and fill, so the affordance survives that fallback.
  dashed: { borderStyle: 'dashed' },
  selected: { borderStyle: 'solid', borderColor: theme.accent, backgroundColor: theme.accentBg },
  label: { color: theme.dim },
  categoryLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.3 },
  optionLabel: { fontSize: 12, fontWeight: '600' },
  selectedLabel: { color: theme.accentDeep },
  pressed: { opacity: 0.6 },
});
