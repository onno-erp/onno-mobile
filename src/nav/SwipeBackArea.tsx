// iOS-style interactive swipe-to-go-back for the host's single content surface.
//
// This app has no native navigation stack — navigation is a single `route` string
// in App.tsx and a back stack the host maintains alongside it (see `history`
// there). This component owns the *gesture and the transition*: a left-edge pan
// drags the live screen (`children`) off to the right while the previous screen
// (`back`, a static card painted from the client's content cache) slides in
// underneath with a subtle parallax + dim, exactly like UIKit's interactive pop.
//
// Past ~40% of the width (or a quick flick) the drag commits: it animates the rest
// of the way, then calls `onBack` — the host pops its stack and loads the previous
// route from cache, so the swap under the finger is seamless (the revealed card and
// the freshly-loaded one are the same surface). Short of the threshold it snaps back.
//
// The reveal layer is mounted only *while a transition is in flight* (`active`), not
// at rest: it carries a full copy of the previous screen, whose data-driven customs
// (onec-list/onec-widget) fetch on mount — we don't want that firing on every
// forward navigation, only when the user actually reaches for "back".
//
// Avoiding the commit flash takes two things, both about the seam where the gesture
// hands the screen back to React:
//   1. The reveal layer renders a *frozen* snapshot of the previous screen captured
//      at drag start, not the live `back` prop. `onBack` mutates the host's stack, so
//      the live prop shifts to the grandparent the instant we commit — the freeze
//      keeps the correct screen on display right through the swap.
//   2. The front isn't dropped back to x=0 until the frame *after* `onBack`, so React
//      has painted the previous screen into the live surface first. Otherwise the
//      front snaps home still showing the outgoing screen for one frame (the flash).
// The frozen layer stays mounted underneath until x has settled at 0, so the gap is
// always covered by the correct screen.
//
// Built on reanimated (already in the app via @gorhom/bottom-sheet) so the drag runs
// on the UI thread at 60fps; the modern Gesture API matches src/divkit/longPress.tsx.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

const EDGE = 28; // left-edge band (px) the gesture is allowed to start in
const COMMIT_RATIO = 0.4; // drag past this fraction of the width to commit a back
const FLING_VELOCITY = 800; // …or flick faster than this (px/s) at release
const PARALLAX = 0.25; // how far (fraction of width) the previous screen lags behind
const DIM_MAX = 0.18; // peak dim over the previous screen when fully covered

export function SwipeBackArea({
  width,
  bg,
  canGoBack,
  routeKey,
  onBack,
  back,
  children,
}: {
  /** Screen width — the full travel distance of a committed back. */
  width: number;
  /** Opaque screen background, painted behind the live surface so it fully
   *  occludes the previous screen at rest. */
  bg: string;
  /** Whether there's anywhere to go back to (host's stack is non-empty). */
  canGoBack: boolean;
  /** Current route; resets any leftover drag offset whenever the screen changes. */
  routeKey: string;
  /** Pop the host's back stack and load the previous route (it's cached → instant). */
  onBack: () => void;
  /** The previous screen, statically rendered from cache; null when unavailable. */
  back: React.ReactNode;
  /** The live, interactive current surface. */
  children: React.ReactNode;
}) {
  const x = useSharedValue(0);
  const enabled = useSharedValue(canGoBack);
  const committing = useSharedValue(false);
  // The reveal layer mounts only during a transition, and shows a snapshot of the
  // previous screen frozen at drag start (see file header).
  const [frozen, setFrozen] = useState<React.ReactNode>(null);

  useEffect(() => {
    enabled.value = canGoBack;
  }, [canGoBack, enabled]);

  // Reset on any screen change (forward nav, or after a committed back) so the new
  // surface always starts square at 0 — never inheriting the prior screen's offset.
  useEffect(() => {
    x.value = 0;
  }, [routeKey, x]);

  // Latest values for the JS-thread callbacks, so the gesture itself stays stable:
  // `onBack`/`back` close over the host's current theme/stack, which change every render.
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const backRef = useRef(back);
  backRef.current = back;

  const beginDrag = useCallback(() => setFrozen(backRef.current), []);
  const endTransition = useCallback(() => {
    committing.value = false;
    setFrozen(null); // unmount the reveal layer
  }, [committing]);
  const commit = useCallback(() => {
    onBackRef.current(); // host swaps the route → the live surface becomes the previous one
    // Frame 1: now that React has painted the previous screen into the front layer,
    // drop it home (x=0). Frame 2: only once that snap has painted, unmount the frozen
    // reveal layer. The freeze covers the whole gap, so no frame shows the wrong screen.
    requestAnimationFrame(() => {
      x.value = 0;
      requestAnimationFrame(() => endTransition());
    });
  }, [x, endTransition]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 0, width: EDGE }) // only arm from the left edge
        .activeOffsetX(12) // claim only on a rightward drag
        .failOffsetY([-14, 14]) // a vertical move yields to the ScrollView
        .onStart(() => {
          'worklet';
          if (!enabled.value) return;
          committing.value = false;
          runOnJS(beginDrag)(); // snapshot + mount the reveal layer for this drag
        })
        .onUpdate((e) => {
          'worklet';
          if (!enabled.value) return;
          x.value = Math.max(0, e.translationX);
        })
        .onEnd((e) => {
          'worklet';
          if (!enabled.value) return;
          const go = e.translationX > width * COMMIT_RATIO || e.velocityX > FLING_VELOCITY;
          if (go) {
            committing.value = true;
            x.value = withTiming(width, { duration: 220 }, (finished) => {
              if (finished) runOnJS(commit)();
            });
          }
          // The snap-back (and unmount) is handled in onFinalize so it also covers a
          // gesture that's interrupted before onEnd fires.
        })
        .onFinalize(() => {
          'worklet';
          if (committing.value) return; // the commit path owns the wind-down
          x.value = withTiming(0, { duration: 180 }, (finished) => {
            if (finished) runOnJS(endTransition)();
          });
        }),
    [width, enabled, x, committing, commit, beginDrag, endTransition],
  );

  const frontStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const backStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(x.value, [0, width], [-width * PARALLAX, 0], Extrapolation.CLAMP) },
    ],
  }));
  const dimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [0, width], [DIM_MAX, 0], Extrapolation.CLAMP),
  }));

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.fill}>
        {frozen != null && (
          <Animated.View style={[StyleSheet.absoluteFill, styles.clip, backStyle]} pointerEvents="none">
            {frozen}
            <Animated.View style={[StyleSheet.absoluteFill, styles.dim, dimStyle]} />
          </Animated.View>
        )}
        <Animated.View style={[styles.fill, styles.shadow, { backgroundColor: bg }, frontStyle]}>
          {children}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  clip: { overflow: 'hidden' },
  dim: { backgroundColor: '#000000' },
  // Soft shadow on the leading (left) edge of the sliding screen, for depth.
  shadow: {
    shadowColor: '#000000',
    shadowOffset: { width: -3, height: 0 },
    shadowOpacity: 0.14,
    shadowRadius: 8,
  },
});
