/**
 * The bottom bar: Bloom's floating `TabBar`, driven by the tab navigator.
 *
 * Rendered through the navigator's `tabBar` slot (see `app/(tabs)/_layout.tsx`),
 * the same arrangement Oxy Commons and Mention use. Each tab carries an
 * outline/filled glyph pair so selection reads as a change of shape as well as
 * color.
 */

import { useCallback } from "react";
import { StyleSheet, View } from "react-native";
import type { BottomTabBarProps } from "expo-router/tabs";
import { TabBar, TabBarButton } from "@oxy.so/bloom/tab-bar";
import { useTheme } from "@oxy.so/bloom/theme";
import { WalletTabIcon, walletTabLabel, type WalletTabName } from "./tabs";

/**
 * Ceiling on the pill's width. Bloom sizes the bar from the window, so on a
 * tablet it would otherwise stretch hundreds of points per item. 440 is the
 * widest phone screen shipping, so no phone is constrained by it.
 */
const TAB_BAR_MAX_WIDTH = 440;

/** Glyph size, matching the bar's own 21pt glyph box. */
const ICON_SIZE = 21;

export function WalletTabBar({
  state,
  navigation,
  tabs,
}: BottomTabBarProps & { tabs: readonly WalletTabName[] }) {
  const theme = useTheme();

  // The navigator's routes include the tabs with no bar entry, so its focused
  // index is not a bar index — resolve the focused route by name instead. That
  // keeps the highlight right through deep links and the Android back gesture.
  const focusedRouteName = state.routes[state.index]?.name;
  const activeIndex = tabs.findIndex((name) => name === focusedRouteName);

  const handleIndexChange = useCallback(
    (index: number) => {
      const name = tabs[index];
      if (name !== undefined) navigation.navigate(name);
    },
    [navigation, tabs],
  );

  return (
    <View style={styles.host}>
      <TabBar activeIndex={activeIndex} onIndexChange={handleIndexChange} maxWidth={TAB_BAR_MAX_WIDTH}>
        {tabs.map((name, index) => (
          <TabBarButton
            key={name}
            index={index}
            item={{
              name,
              label: walletTabLabel(name),
              // Pre-colored with the bar's own default tints (Bloom's
              // `activeTint` is `text`, `inactiveTint` is `textSecondary`).
              icon: <WalletTabIcon name={name} active={false} color={theme.colors.textSecondary} size={ICON_SIZE} />,
              activeIcon: <WalletTabIcon name={name} active color={theme.colors.text} size={ICON_SIZE} />,
            }}
          />
        ))}
      </TabBar>
    </View>
  );
}

const styles = StyleSheet.create({
  // The navigator lays this out as the last child of a flex column. Left in
  // flow it would shrink every screen by the bar's height; a floating bar must
  // not, so the host is pulled out of flow and pinned to the bottom edge. Bloom's
  // bar positions itself absolutely against this zero-height host.
  //
  // `pointerEvents` in the style object: react-native-web warns on the prop.
  host: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: "box-none",
  },
});
