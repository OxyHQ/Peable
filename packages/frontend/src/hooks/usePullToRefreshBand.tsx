/**
 * Pull-to-refresh driven by the rainbow band, shared by every screen that
 * offers a refresh.
 *
 * The band IS the indicator — there is no native `RefreshControl` anywhere in
 * this app — so the reveal, the trigger threshold, the haptics and how long the
 * band stays open have to be identical wherever a refresh exists, or the two
 * screens feel like two apps. That is why this lives in one place instead of
 * being copied per screen.
 *
 * Two entry points, one behaviour:
 *
 *  - **Pull.** A Pan gesture composed *simultaneously* with the scroll view's
 *    own native gesture, so dragging at the top reveals the band while ordinary
 *    scrolling keeps working. Past {@link REFRESH_TRIGGER} it ticks a haptic
 *    once (re-arming if the user drags back below), and releasing past the
 *    threshold runs the refresh.
 *  - **A button.** {@link PullToRefreshBand.trigger} opens the band and runs the
 *    same path, for screens with a refresh action in the header.
 *
 * The band always stays open for {@link REFRESH_HOLD_MS}. Refresh work can
 * finish in milliseconds — a rescan with nothing to scan returns immediately —
 * and collapsing the band the instant it does reads as a flicker, or as the tap
 * never registering.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Gesture } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import {
  RefreshRainbowBar,
  RAINBOW_BAND_HEIGHT,
  REFRESH_HOLD_MS,
} from "../ui/components/RefreshRainbowBar";
import { hapticSelection, hapticSuccess } from "../utils/haptics";

/** Reveal (px) the pull must reach on release to trigger a refresh. */
const REFRESH_TRIGGER = 42;
/** Damping applied to finger travel so the band trails the drag. */
const PULL_DAMPING = 0.6;
/** Band open/close animation, in ms. */
const OPEN_MS = 140;
const CLOSE_MS = 220;
/** Snap-back when released below the trigger. */
const CANCEL_MS = 140;

/**
 * @param onRefresh Work to run when a refresh starts. Called at most once per
 *   refresh; it may be async, and its duration does not shorten or extend the
 *   band's hold.
 */
export function usePullToRefreshBand(onRefresh: () => void | Promise<void>) {
  const scrollY = useSharedValue(0);
  const pull = useSharedValue(0);
  // Mirrored on the UI thread so the gesture worklets can read "already
  // refreshing" without hopping to JS.
  const refreshingSV = useSharedValue(false);
  /** True once this drag passed the threshold, for a one-shot haptic. */
  const passedTrigger = useSharedValue(false);
  const [refreshing, setRefreshing] = useState(false);

  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollY.set(event.contentOffset.y);
  });

  const start = useCallback(() => {
    void onRefresh();
    setRefreshing(true);
  }, [onRefresh]);

  // Hold the band, then collapse it. Keyed on state rather than a ref so the
  // timer is cleaned up if the screen unmounts mid-refresh.
  useEffect(() => {
    if (!refreshing) return;
    const id = setTimeout(() => {
      refreshingSV.set(false);
      pull.set(withTiming(0, { duration: CLOSE_MS }));
      // A distinct "done" haptic as the band collapses.
      hapticSuccess();
      setRefreshing(false);
    }, REFRESH_HOLD_MS);
    return () => clearTimeout(id);
  }, [refreshing, pull, refreshingSV]);

  const trigger = useCallback(() => {
    if (refreshing) return;
    refreshingSV.set(true);
    pull.set(withTiming(RAINBOW_BAND_HEIGHT, { duration: OPEN_MS }));
    start();
  }, [refreshing, pull, refreshingSV, start]);

  const pullGesture = useMemo(
    () =>
      Gesture.Pan()
        .onBegin(() => {
          "worklet";
          passedTrigger.set(false);
        })
        .onUpdate((event) => {
          "worklet";
          if (refreshingSV.get()) return;
          const next =
            scrollY.get() <= 0 && event.translationY > 0
              ? Math.min(event.translationY * PULL_DAMPING, RAINBOW_BAND_HEIGHT)
              : 0;
          // Light haptic tick the first time the pull passes the trigger; re-arm
          // if the user drags back below it so a second pull ticks again.
          if (!passedTrigger.get() && next >= REFRESH_TRIGGER) {
            passedTrigger.set(true);
            runOnJS(hapticSelection)();
          } else if (passedTrigger.get() && next < REFRESH_TRIGGER) {
            passedTrigger.set(false);
          }
          pull.set(next);
        })
        .onEnd(() => {
          "worklet";
          if (refreshingSV.get()) return;
          if (pull.get() >= REFRESH_TRIGGER) {
            refreshingSV.set(true);
            pull.set(withTiming(RAINBOW_BAND_HEIGHT, { duration: OPEN_MS }));
            runOnJS(start)();
          } else {
            pull.set(withTiming(0, { duration: CANCEL_MS }));
          }
        }),
    [scrollY, pull, refreshingSV, passedTrigger, start],
  );

  // Simultaneous with the scroll view's own gesture: dragging at the top
  // reveals the band, everything else scrolls normally.
  const gesture = useMemo(
    () => Gesture.Simultaneous(pullGesture, Gesture.Native()),
    [pullGesture],
  );

  const bandStyle = useAnimatedStyle(() => ({ height: pull.get() }));

  // The band is only mounted while it is actually revealed. It renders 70
  // views and drives an infinite `withRepeat` transform, so leaving it mounted
  // behind a zero-height clip burns UI-thread work every frame, on every
  // screen that offers a refresh, forever.
  const [bandVisible, setBandVisible] = useState(false);
  useAnimatedReaction(
    () => pull.get() > 0,
    (revealed, previous) => {
      if (revealed !== previous) runOnJS(setBandVisible)(revealed);
    },
  );

  // Returned as an element rather than as a style, so the clip, the overflow
  // and the mount condition cannot drift between the screens that use it.
  const band = (
    <Animated.View style={[bandStyle, { overflow: "hidden" }]}>
      {bandVisible ? <RefreshRainbowBar /> : null}
    </Animated.View>
  );

  return {
    /** Attach to the `GestureDetector` wrapping the scroll view. */
    gesture,
    /** Pass to the `Animated.ScrollView`'s `onScroll`. */
    scrollHandler,
    /** The rainbow band, ready to render above the scroll view. */
    band,
    /** Start a refresh from a button instead of a pull. */
    trigger,
    /** True while the band is held open. */
    refreshing,
  };
}

export type PullToRefreshBand = ReturnType<typeof usePullToRefreshBand>;
