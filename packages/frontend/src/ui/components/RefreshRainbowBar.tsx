/**
 * RefreshRainbowBar — a horizontally flowing band of rainbow colour blocks.
 *
 * It renders a full-height (`BAND_HEIGHT`) row whose colours scroll left forever.
 * It does NOT manage its own reveal: the parent clips it to the current
 * pull-to-refresh height, so as the user drags the band is progressively
 * revealed from the top. The colour row is doubled so the looping translate is
 * seamless.
 *
 * The palette is a rainbow for now (a deliberate, playful placeholder); it will
 * be swapped for the FairCoin palette later.
 */

import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

/** Distinct rainbow stops (7 gradients × 5 shades) flowed end to end. */
const RAINBOW_STOPS = [
  "#b983d6", "#a65dc2", "#944bb4", "#9d3ea2", "#c03a92",
  "#d6458d", "#ec5e73", "#f77a52", "#f99145", "#fbad5c",
  "#fbad5c", "#fcb75e", "#fcca60", "#fadb74", "#f8ea9a",
  "#e7f196", "#c6e47f", "#99d472", "#6bc36c", "#42b067",
  "#42b067", "#3a9e83", "#3a8e8e", "#3e7c91", "#476998",
  "#476998", "#4a5fa5", "#5c59b5", "#734fbf", "#8942c2",
  "#8942c2", "#9b3ca9", "#b3398c", "#c73f6b", "#d9484f",
];

const BLOCK_WIDTH = 20;
/** Full band height; the parent reveals 0…this many px as the user pulls. */
export const RAINBOW_BAND_HEIGHT = 52;
/**
 * How long the band stays open once a refresh starts.
 *
 * A refresh can finish in a few milliseconds — a rescan with nothing to scan
 * returns immediately — and collapsing the band the moment it does reads as a
 * flicker, or as the tap not registering at all. Holding it for a beat makes
 * the action legible; a refresh that takes longer simply keeps it open longer.
 */
export const REFRESH_HOLD_MS = 1500;
/** One palette width — translating by exactly this makes the loop seamless. */
const SET_WIDTH = RAINBOW_STOPS.length * BLOCK_WIDTH;
const FLOW_DURATION_MS = 1400;

export function RefreshRainbowBar() {
  const flow = useSharedValue(0);

  useEffect(() => {
    flow.set(0);
    flow.set(
      withRepeat(
        withTiming(-SET_WIDTH, {
          duration: FLOW_DURATION_MS,
          easing: Easing.linear,
        }),
        -1,
        false,
      ),
    );
  }, [flow]);

  const flowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: flow.get() }],
  }));

  // Animation code: the flowing transform is a shared value and the row/block
  // dimensions feed the scroll math, so this styles inline by necessity.
  return (
    <Animated.View
      style={[
        flowStyle,
        { flexDirection: "row", height: RAINBOW_BAND_HEIGHT, width: SET_WIDTH * 2 },
      ]}
    >
      {[...RAINBOW_STOPS, ...RAINBOW_STOPS].map((color, index) => (
        <View
          key={index}
          style={{ width: BLOCK_WIDTH, height: RAINBOW_BAND_HEIGHT, backgroundColor: color }}
        />
      ))}
    </Animated.View>
  );
}
