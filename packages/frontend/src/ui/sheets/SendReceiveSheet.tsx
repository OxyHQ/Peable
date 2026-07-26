/**
 * Combined Send / Receive bottom-sheet body.
 *
 * A single content-only body with a Send | Receive segmented toggle at the top,
 * so the home Send / Receive pills open ONE sheet and the user can flip between
 * the two flows without closing it. Below the toggle it renders the existing
 * content-only bodies verbatim: {@link SendSheet} for `"send"`, and
 * {@link ReceiveSheet} with `heading={false}` for `"receive"` — the toggle is
 * the header, so the receive body suppresses its own "Receive" title.
 *
 * Like `SendSheet` / `ReceiveSheet`, this renders NO full-screen wrapper and
 * NO safe-area padding — it lives inside a Bloom
 * bottom-sheet `<Dialog placement="bottom">`. It also renders NO scroll
 * container of its own, and that is deliberate: the host `<Dialog>` must own the
 * scroll.
 *
 * SCROLL (host contract): the send form is tall and must scroll. Bloom's Dialog
 * is NOT backed by `@gorhom/bottom-sheet`, so `@gorhom/bottom-sheet`'s
 * `BottomSheetScrollView` cannot be used here — it hard-throws
 * `"'useBottomSheetInternal' cannot be used out of the BottomSheet!"` outside a
 * gorhom sheet. A plain React Native `ScrollView` does not work either: Bloom's
 * drag-to-dismiss pan is uncoordinated with a foreign scroller and intercepts
 * the drag. The scroll therefore has to come from Bloom's own internal
 * `ScrollView`, which Bloom enables whenever the host `<Dialog>` carries
 * declarative chrome. Bloom keys that on `title !== undefined` but only *renders*
 * a visible title when `title` is truthy — so the host must open this sheet with
 * `title=""` (an empty string): Bloom scrolls the body, yet shows no header text,
 * leaving this component's toggle as the sole header. Adding a scroller here as
 * well would produce a scroll-in-scroll, so this body stays scroller-free —
 * exactly like the sibling sheets.
 */

import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { SendSheet } from "./SendSheet";
import { ReceiveSheet } from "./ReceiveSheet";
import { hapticSelection } from "../../utils/haptics";
import { t } from "../../i18n";

type Mode = "send" | "receive";

const MODES: readonly Mode[] = ["send", "receive"] as const;
const CONTENT_MAX_WIDTH = 600;
// A fling faster than this (px/s) flips the page regardless of drag distance.
const SWIPE_VELOCITY = 500;
const PAGE_ANIM_MS = 220;

function getModeLabel(mode: Mode): string {
  return mode === "send" ? t("wallet.send") : t("wallet.receive");
}

export function SendReceiveSheet({
  mode,
  onModeChange,
  address,
  amount,
}: {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  address?: string;
  amount?: string;
}): React.JSX.Element {
  // Live horizontal pager: Send (left) and Receive (right) are both mounted,
  // side by side, and `translateX` tracks the finger in real time so the pages
  // slide as the user drags. On release it snaps to the nearer page (with a
  // velocity assist) and reports the new mode. Page width is measured from the
  // container so the snap math is exact; the row uses percentage widths so it
  // lays out correctly before the first measurement (no flash).
  const [pageWidth, setPageWidth] = useState(0);
  // Shared mirror of the width for worklets (avoids stale JS captures).
  const pageW = useSharedValue(0);
  const translateX = useSharedValue(0);
  // Measured natural height of each page, so the pager can grow/shrink to the
  // active one and the shorter page (Receive) doesn't leave dead space.
  const sendH = useSharedValue(0);
  const recvH = useSharedValue(0);

  // The resting X for the active page. Kept in sync when the mode is changed by
  // the toggle (not by a drag), and settles the pages once width is measured.
  const restingX = mode === "send" ? 0 : -pageWidth;
  useEffect(() => {
    translateX.set(withTiming(restingX, { duration: PAGE_ANIM_MS }));
  }, [restingX, translateX]);

  const pageGesture = useMemo(
    () =>
      Gesture.Pan()
        // Only claim clearly-horizontal drags so vertical scroll / taps pass
        // through to the sheet + the page contents.
        .activeOffsetX([-12, 12])
        .failOffsetY([-14, 14])
        .onUpdate((e) => {
          "worklet";
          const width = pageW.get();
          const base = mode === "send" ? 0 : -width;
          translateX.set(Math.max(-width, Math.min(0, base + e.translationX)));
        })
        .onEnd((e) => {
          "worklet";
          const width = pageW.get();
          if (width === 0) return;
          const base = mode === "send" ? 0 : -width;
          const pos = base + e.translationX;
          let next: Mode;
          if (e.velocityX < -SWIPE_VELOCITY) next = "receive";
          else if (e.velocityX > SWIPE_VELOCITY) next = "send";
          else next = pos < -width / 2 ? "receive" : "send";
          translateX.set(
            withTiming(next === "send" ? 0 : -width, {
              duration: PAGE_ANIM_MS,
            }),
          );
          if (next !== mode) {
            runOnJS(hapticSelection)();
            runOnJS(onModeChange)(next);
          }
        }),
    [mode, pageW, translateX, onModeChange],
  );

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.get() }],
  }));

  // Pager height follows the drag position, interpolating between the two
  // pages' measured heights so the sheet grows/shrinks smoothly as you swipe.
  const heightStyle = useAnimatedStyle(() => {
    const from = sendH.get();
    const to = recvH.get();
    if (from === 0 || to === 0) {
      const single = from || to;
      return single > 0 ? { height: single } : {};
    }
    const width = pageW.get();
    const progress =
      width > 0 ? Math.min(1, Math.max(0, -translateX.get() / width)) : 0;
    return { height: from + (to - from) * progress };
  });

  return (
    <View
      className="w-full self-center gap-5 pt-2 pb-4"
      style={{ maxWidth: CONTENT_MAX_WIDTH }}
    >
      {/* Send | Receive segmented toggle — the sheet's header. Own horizontal
          inset (the sheet is full-bleed so the pager can slide edge-to-edge). */}
      <View className="flex-row bg-surface rounded-full p-1 mx-5">
        {MODES.map((segment) => {
          const isActive = mode === segment;
          return (
            <Pressable
              key={segment}
              onPress={() => onModeChange(segment)}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={getModeLabel(segment)}
              // `active:` must stay on the class list for BOTH states: adding or
              // removing a pressable variant after the first render makes
              // react-native-css reset the component and re-mount its children.
              className={`flex-1 rounded-full py-2.5 items-center active:opacity-70 ${
                isActive ? "bg-primary" : "bg-transparent"
              }`}
            >
              <Text
                className={`text-sm font-semibold ${
                  isActive ? "text-primary-foreground" : "text-muted-foreground"
                }`}
              >
                {getModeLabel(segment)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Paged content — both bodies mounted side by side; the row slides with
          the drag. `overflow-hidden` clips the off-screen page. */}
      <Animated.View
        className="overflow-hidden"
        style={heightStyle}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          setPageWidth(w);
          pageW.set(w);
        }}
      >
        <GestureDetector gesture={pageGesture}>
          <Animated.View
            style={[{ flexDirection: "row", width: "200%" }, rowStyle]}
          >
            {/* Each page owns its horizontal inset so it fills the sheet width
                and slides fully off-screen (no hiding inside a shared padding). */}
            <View
              className="px-5"
              style={{ width: "50%" }}
              onLayout={(e) => {
                sendH.set(e.nativeEvent.layout.height);
              }}
            >
              <SendSheet address={address} amount={amount} />
            </View>
            <View
              className="px-5"
              style={{ width: "50%" }}
              onLayout={(e) => {
                recvH.set(e.nativeEvent.layout.height);
              }}
            >
              <ReceiveSheet heading={false} />
            </View>
          </Animated.View>
        </GestureDetector>
      </Animated.View>
    </View>
  );
}
