/**
 * The "All Tasks ▾" header (MOBILE_TODAY_PLAN §2 #18). Controlled: the fold
 * state belongs to the screen, so it can survive a tab switch.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../ui';

export function SectionFold({
  title,
  open,
  onToggle,
  count,
  testID,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  count?: number;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onToggle}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={count === undefined ? title : `${title}, ${count}`}
      style={({ pressed }) => [s.row, pressed && s.pressed]}
    >
      <Text style={s.title}>{title}</Text>
      {count !== undefined && <Text style={s.count}>{count}</Text>}
      <View style={[s.chevron, !open && s.chevronClosed]}>
        <Text style={s.chevronGlyph}>▾</Text>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 7, alignSelf: 'flex-start', paddingTop: 2, paddingBottom: 4 },
  title: { color: theme.text, fontSize: 13.5, fontWeight: '700' },
  count: { color: theme.faint, fontSize: 12, fontWeight: '700' },
  chevron: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  chevronClosed: { transform: [{ rotate: '-90deg' }] },
  chevronGlyph: { color: theme.dim, fontSize: 12, lineHeight: 14 },
  pressed: { opacity: 0.6 },
});
