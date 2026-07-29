/**
 * The soft edge a scrolling list runs under (MOBILE_TODAY_PLAN §2 #31) — the
 * mock's `.fade` and the bottom action bar's backdrop. It says "there is more
 * here" without a hard rule across the screen.
 *
 * `expo-linear-gradient` is the one dependency this plan adds (D8). The fade
 * always runs from a colour to *that same colour* at zero alpha (see
 * `withAlpha`), never to `'transparent'`.
 */
import { StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import type { StyleProp, ViewStyle } from 'react-native';

import { withAlpha } from '../color';
import { theme } from '../ui';

export function FadeEdge({
  placement,
  color = theme.bg,
  height = 26,
  style,
}: {
  placement: 'top' | 'bottom';
  color?: string;
  height?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const clear = withAlpha(color, 0);
  return (
    <LinearGradient
      pointerEvents="none"
      colors={placement === 'top' ? [color, clear] : [clear, color]}
      style={[s.edge, placement === 'top' ? s.top : s.bottom, { height }, style]}
    />
  );
}

const s = StyleSheet.create({
  edge: { position: 'absolute', left: 0, right: 0, zIndex: 4 },
  top: { top: 0 },
  bottom: { bottom: 0 },
});
