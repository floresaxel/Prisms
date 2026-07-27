/**
 * The bottom sheet both Today sheets sit on (MOBILE_TODAY_PLAN §2 #20/#28/#30).
 *
 * It slides up to a *measured* `top` rather than a fixed height: the mock puts
 * the day note just under the first itinerary row and the new-task sheet just
 * under the fourth, so the day you are writing about stays on screen behind it.
 *
 * It stays mounted while closed — that is what lets `onLayout` measure the
 * travel, and it keeps a half-typed note alive across an accidental dismiss —
 * so it is hidden from touches *and* from screen readers when closed.
 *
 * Every way out of a sheet is wired here once: the catcher behind it, a
 * drag-down on the grab bar, and Android's hardware back button.
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, BackHandler, Easing, PanResponder, Pressable, StyleSheet, View } from 'react-native';

import type { ReactNode } from 'react';

import { theme } from '../ui';
import { useReduceMotion } from './motion';

/** Extra travel so the sheet's drop shadow clears the screen edge too. */
const SHADOW_CLEARANCE = 24;
const OPEN_MS = 260;

export function SheetBase({
  open,
  onClose,
  top,
  children,
  accessibilityLabel,
  testID,
}: {
  open: boolean;
  onClose: () => void;
  /** Distance from the top of the containing screen, measured from the rows. */
  top: number;
  children: ReactNode;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const reduceMotion = useReduceMotion();
  const [height, setHeight] = useState(0);

  // Read by the pan handlers, which are created once and would otherwise
  // capture the first render's values.
  const hiddenRef = useRef(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const ty = useRef(new Animated.Value(9999)).current;
  const fade = useRef(new Animated.Value(1)).current;

  const hidden = height + SHADOW_CLEARANCE;
  hiddenRef.current = hidden;

  useEffect(() => {
    if (height === 0) return; // nothing measured yet — stay parked off-screen
    if (reduceMotion) {
      ty.setValue(open ? 0 : hidden);
      const f = Animated.timing(fade, { toValue: open ? 1 : 0, duration: 140, useNativeDriver: true });
      f.start();
      return () => f.stop();
    }
    fade.setValue(1);
    const slide = Animated.timing(ty, {
      toValue: open ? 0 : hidden,
      duration: OPEN_MS,
      easing: Easing.bezier(0.3, 0.9, 0.3, 1),
      useNativeDriver: true,
    });
    slide.start();
    return () => slide.stop();
  }, [open, height, hidden, reduceMotion, ty, fade]);

  // Android hardware back closes the sheet instead of leaving the screen.
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onCloseRef.current();
      return true;
    });
    return () => sub.remove();
  }, [open]);

  const pan = useRef(
    PanResponder.create({
      // Only a downward drag — anything more horizontal belongs to the content.
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_e, g) => {
        if (g.dy > 0) ty.setValue(Math.min(hiddenRef.current, g.dy));
      },
      onPanResponderRelease: (_e, g) => {
        const past = g.dy > Math.max(80, hiddenRef.current * 0.3) || g.vy > 0.6;
        if (past) {
          onCloseRef.current();
          return;
        }
        Animated.timing(ty, { toValue: 0, duration: 180, easing: Easing.out(Easing.ease), useNativeDriver: true }).start();
      },
      onPanResponderTerminate: () => {
        Animated.timing(ty, { toValue: 0, duration: 180, useNativeDriver: true }).start();
      },
    }),
  ).current;

  return (
    <>
      {open && (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          testID={testID === undefined ? undefined : `${testID}-catcher`}
        />
      )}
      <Animated.View
        testID={testID}
        onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
        pointerEvents={open ? 'auto' : 'none'}
        accessibilityViewIsModal={open}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? 'yes' : 'no-hide-descendants'}
        accessibilityLabel={accessibilityLabel}
        style={[s.sheet, { top, opacity: fade, transform: [{ translateY: ty }] }]}
      >
        <View {...pan.panHandlers} style={s.grabArea} accessible={false}>
          <View style={s.grab} />
        </View>
        {children}
      </Animated.View>
    </>
  );
}

const s = StyleSheet.create({
  sheet: {
    position: 'absolute',
    // Stops short of the right edge so the 24 h day map stays visible and
    // draggable while a sheet is open.
    left: 10,
    right: 26,
    bottom: 0,
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    zIndex: 8,
    shadowColor: '#101828',
    shadowOffset: { width: 0, height: -12 },
    shadowOpacity: 0.18,
    shadowRadius: 32,
    elevation: 16,
  },
  grabArea: { paddingTop: 9, paddingBottom: 6, alignItems: 'center' },
  grab: { width: 38, height: 4, borderRadius: 2, backgroundColor: theme.border2 },
});
