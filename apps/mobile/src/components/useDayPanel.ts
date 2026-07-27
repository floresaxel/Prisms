/**
 * The drag that opens the day calendar (MOBILE_TODAY_PLAN §2 #16, T3).
 *
 * One controller for both ends of the gesture: pulling the day-map bar leftwards
 * opens the panel, pushing the open panel rightwards closes it, and a plain tap
 * on the bar toggles. Living in one hook is what keeps the two responders from
 * fighting over the same `translateX`.
 *
 * Plan §6 risk — the bar sits beside a scrolling list, so the responder is only
 * claimed when the finger is travelling more horizontally than vertically.
 * Otherwise a slightly-off vertical swipe would steal the scroll.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { Animated, Easing, PanResponder } from 'react-native';

import type { GestureResponderHandlers } from 'react-native';

import { useReduceMotion } from './motion';

/** Panel width plus enough to carry its shadow off-screen. */
export const DAY_PANEL_WIDTH = 224;
const TRAVEL = DAY_PANEL_WIDTH + 12;
/** Past this fraction of the travel the panel falls closed rather than open. */
const SNAP = 0.55;
const SETTLE_MS = 240;

export interface DayPanelController {
  open: boolean;
  close: () => void;
  translateX: Animated.Value;
  /** 1 when open, 0 when closed — drives the scrim. */
  scrimOpacity: Animated.AnimatedInterpolation<number>;
  panelOpacity: Animated.Value;
  toggle: () => void;
  barPanHandlers: GestureResponderHandlers;
  panelPanHandlers: GestureResponderHandlers;
}

export function useDayPanel(): DayPanelController {
  const reduceMotion = useReduceMotion();
  const [open, setOpen] = useState(false);

  const translateX = useRef(new Animated.Value(TRAVEL)).current;
  const panelOpacity = useRef(new Animated.Value(0)).current;

  // The responders are built once, so they read live state through refs.
  const openRef = useRef(open);
  openRef.current = open;
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;

  const settle = useCallback(
    (toOpen: boolean) => {
      setOpen(toOpen);

      // D8: no slide under reduce-motion. Position first when opening, and
      // only move off-screen after fading out when closing, so neither
      // direction shows the panel jumping across the screen.
      if (reduceMotionRef.current) {
        if (toOpen) translateX.setValue(0);
        Animated.timing(panelOpacity, { toValue: toOpen ? 1 : 0, duration: 140, useNativeDriver: true }).start(
          ({ finished }) => {
            if (finished && !toOpen) translateX.setValue(TRAVEL);
          },
        );
        return;
      }

      panelOpacity.setValue(1);
      Animated.timing(translateX, {
        toValue: toOpen ? 0 : TRAVEL,
        duration: SETTLE_MS,
        easing: Easing.bezier(0.3, 0.9, 0.3, 1),
        useNativeDriver: true,
      }).start();
    },
    [translateX, panelOpacity],
  );

  const makeResponder = useCallback(
    (fromOpen: () => boolean, wants: (dx: number, dy: number) => boolean, claimTaps: boolean) => {
      let base = 0;
      let moved = false;
      let last = 0;

      return PanResponder.create({
        // The bar claims the touch outright: it is a dedicated 14 px lane, and
        // owning the tap here means one responder handles both tap and drag —
        // no `Pressable` alongside it to fight over the same gesture.
        onStartShouldSetPanResponder: () => claimTaps,
        onMoveShouldSetPanResponder: (_e, g) => wants(g.dx, g.dy),
        onPanResponderGrant: () => {
          base = fromOpen() ? 0 : TRAVEL;
          last = base;
          moved = false;
          panelOpacity.setValue(1);
        },
        onPanResponderMove: (_e, g) => {
          if (Math.abs(g.dx) > 4) moved = true;
          last = Math.min(TRAVEL, Math.max(0, base + g.dx));
          translateX.setValue(last);
        },
        onPanResponderRelease: () => {
          // A tap (no travel) toggles; a drag lands wherever it was let go.
          settle(moved ? last < TRAVEL * SNAP : !fromOpen());
        },
        onPanResponderTerminate: () => settle(fromOpen()),
      });
    },
    [settle, translateX, panelOpacity],
  );

  const barResponder = useMemo(
    // Leftward and horizontal — anything else belongs to the list's scroll.
    () => makeResponder(() => openRef.current, (dx, dy) => dx < -4 && Math.abs(dx) > Math.abs(dy), true),
    [makeResponder],
  );

  // The panel wraps a ScrollView, so it must NOT claim taps — only a clearly
  // horizontal drag, or vertical scrolling inside it would stop working.
  const panelResponder = useMemo(
    () => makeResponder(() => openRef.current, (dx, dy) => Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy), false),
    [makeResponder],
  );

  const scrimOpacity = useMemo(
    () => translateX.interpolate({ inputRange: [0, TRAVEL], outputRange: [1, 0], extrapolate: 'clamp' }),
    [translateX],
  );

  return {
    open,
    close: useCallback(() => settle(false), [settle]),
    toggle: useCallback(() => settle(!openRef.current), [settle]),
    translateX,
    scrimOpacity,
    panelOpacity,
    barPanHandlers: barResponder.panHandlers,
    panelPanHandlers: panelResponder.panHandlers,
  };
}
