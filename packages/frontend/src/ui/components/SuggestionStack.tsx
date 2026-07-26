/**
 * SuggestionStack — a swipable "deck" of reminder / suggestion cards for the
 * home screen. The top card is interactive and can be flung left or right to
 * dismiss it; behind it, up to two narrower, dimmer cards peek out to show more
 * remain. Dismissing the top card promotes the next. Empty deck → renders
 * nothing.
 *
 * Each card is its own keyed component with its own animated offset, so a
 * dismissed card flies off-screen and unmounts while the next mounts fresh at
 * rest — no snap-back flash.
 */

import { useMemo } from "react";
import { View, Text, Pressable } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useTheme } from "@oxyhq/bloom/theme";

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>["name"];

export interface Suggestion {
  id: string;
  icon: IconName;
  title: string;
  /** Optional pill (e.g. "Required"). */
  badge?: string;
  subtitle: string;
  onPress: () => void;
}

// Horizontal travel / fling velocity past which a swipe dismisses the card.
const DISMISS_DX = 96;
const FLING_VELOCITY = 600;
// How far off-screen a dismissed card flies before it unmounts.
const OFFSCREEN = 500;

function SwipableCard({
  item,
  onDismiss,
}: {
  item: Suggestion;
  onDismiss: (id: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const translateX = useSharedValue(0);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        // Only claim clearly-horizontal drags so vertical scroll / taps pass.
        .activeOffsetX([-12, 12])
        .failOffsetY([-16, 16])
        .onUpdate((e) => {
          "worklet";
          translateX.set(e.translationX);
        })
        .onEnd((e) => {
          "worklet";
          const dismiss =
            Math.abs(e.translationX) > DISMISS_DX ||
            Math.abs(e.velocityX) > FLING_VELOCITY;
          if (dismiss) {
            const dir = e.translationX < 0 || e.velocityX < 0 ? -1 : 1;
            translateX.set(
              withTiming(dir * OFFSCREEN, { duration: 180 }, (done) => {
                if (done) runOnJS(onDismiss)(item.id);
              }),
            );
          } else {
            translateX.set(withTiming(0, { duration: 150 }));
          }
        }),
    [translateX, onDismiss, item.id],
  );

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.get() }],
    opacity: 1 - Math.min(1, Math.abs(translateX.get()) / OFFSCREEN) * 0.5,
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={style}>
        <Pressable
          onPress={item.onPress}
          className="flex-row items-start gap-3 bg-surface border border-border rounded-[28px] p-4 active:opacity-90"
          accessibilityRole="button"
          accessibilityLabel={item.title}
        >
          <View className="w-10 h-10 rounded-full bg-primary/10 items-center justify-center">
            <MaterialCommunityIcons
              name={item.icon}
              size={20}
              color={theme.colors.primary}
            />
          </View>
          <View className="flex-1">
            <View className="flex-row items-center">
              <Text
                className="text-foreground text-sm font-semibold flex-1"
                numberOfLines={1}
              >
                {item.title}
              </Text>
              {item.badge ? (
                <View className="bg-primary/15 rounded-full px-2 py-0.5 ml-2">
                  <Text className="text-primary text-[10px] font-bold uppercase tracking-wide">
                    {item.badge}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              className="text-muted-foreground text-xs mt-1 leading-4"
              numberOfLines={2}
            >
              {item.subtitle}
            </Text>
          </View>
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}

export function SuggestionStack({
  items,
  onDismiss,
}: {
  items: Suggestion[];
  onDismiss: (id: string) => void;
}): React.JSX.Element | null {
  if (items.length === 0) return null;
  const top = items[0];
  const behind = Math.min(2, items.length - 1);

  return (
    <View>
      {/* Deck: dimmer, narrower cards peeking below to show more remain. */}
      {behind >= 2 ? (
        <View
          className="absolute left-6 right-6 top-0 bottom-0 bg-surface border border-border rounded-[28px] opacity-45"
          style={{ transform: [{ translateY: 14 }] }}
        />
      ) : null}
      {behind >= 1 ? (
        <View
          className="absolute left-3 right-3 top-0 bottom-0 bg-surface border border-border rounded-[28px] opacity-75"
          style={{ transform: [{ translateY: 7 }] }}
        />
      ) : null}
      <SwipableCard key={top.id} item={top} onDismiss={onDismiss} />
    </View>
  );
}
