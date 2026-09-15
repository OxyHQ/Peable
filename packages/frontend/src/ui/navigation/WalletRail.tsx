/**
 * The side rail for a wide browser window: Bloom's `Rail`, driven by the tab
 * navigator.
 *
 * Rendered through the navigator's `tabBar` slot with `tabBarPosition: "left"`,
 * so the navigator itself lays the rail beside the screens — no hand-built
 * flex row, and none of the `TabSlot` flex-shrink workarounds the previous
 * headless-tabs web layout needed to keep its screens scrollable.
 */

import { useCallback } from "react";
import type { BottomTabBarProps } from "expo-router/tabs";
import { Rail } from "@oxy.so/bloom/rail";
import { useTheme } from "@oxy.so/bloom/theme";
import { WalletTabIcon, walletTabLabel, type WalletTabName } from "./tabs";

const ICON_SIZE = 24;

export function WalletRail({
  state,
  navigation,
  tabs,
}: BottomTabBarProps & { tabs: readonly WalletTabName[] }) {
  const theme = useTheme();
  const focusedRouteName = state.routes[state.index]?.name;

  const handleSelect = useCallback(
    (id: string) => {
      navigation.navigate(id);
    },
    [navigation],
  );

  return (
    <Rail
      activeId={focusedRouteName}
      onSelect={handleSelect}
      style={{
        backgroundColor: theme.colors.background,
        borderRightWidth: 1,
        borderRightColor: theme.colors.border,
      }}
      items={tabs.map((name) => ({
        id: name,
        label: walletTabLabel(name),
        // The rail draws the active item's pill in `primary-subtle`; its glyph
        // takes that pill's foreground.
        icon: <WalletTabIcon name={name} active={false} color={theme.colors.textSecondary} size={ICON_SIZE} />,
        activeIcon: (
          <WalletTabIcon name={name} active color={theme.colors.primarySubtleForeground} size={ICON_SIZE} />
        ),
      }))}
    />
  );
}
