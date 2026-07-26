/**
 * Tab layout for Web (Electron desktop).
 * Uses headless tabs from expo-router/ui with Material Design 3 responsive
 * navigation:
 *
 *   - Compact  (< 600px): bottom navigation bar (row, icon + label)
 *   - Medium+  (>= 600px): navigation rail on the left (80px, icon centered
 *                          with label below, rounded pill active indicator
 *                          behind the icon only)
 *
 * On ultrawide displays (>= 1400px) the content column is capped at
 * `CONTENT_MAX_WIDTH` so that text and cards don't stretch across the viewport.
 *
 * IMPORTANT: `TabTrigger` must appear as a direct child of `TabList`. Wrapping
 * them in helper components breaks expo-router's child parser, which looks up
 * triggers by React element type, not by the rendered output.
 *
 * Flex / scroll notes (react-native-web):
 *   - `<Tabs>` defaults to `flexDirection: 'column'`; we pass an explicit
 *     `flexDirection: 'row'` via `style` so the rail sits beside the content.
 *   - `<TabSlot />` is wrapped in a `<View>` with `flex: 1, minHeight: 0` so
 *     the screen container receives a bounded height; without `minHeight: 0`
 *     react-native-web refuses to shrink flex children below their intrinsic
 *     height, which breaks vertical scrolling inside `<ScrollView>`.
 */

import { Tabs, TabList, TabTrigger, useTabSlot } from "expo-router/ui";
import { usePathname } from "expo-router";
import { Screen } from "react-native-screens";
import {
  View,
  Text,
  StyleSheet,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { t } from "../../src/i18n";
import { useTheme } from "@oxyhq/bloom/theme";

const MEDIUM_BREAKPOINT = 600;
const RAIL_WIDTH = 80;
const RAIL_INDICATOR_WIDTH = 56;
const RAIL_INDICATOR_HEIGHT = 32;
const RAIL_ICON_SIZE = 24;

// Override for `expo-router/ui`'s `defaultTabsSlotRender`. The built-in
// version hard-codes `flexShrink: 0` on both the `ScreenContainer` and
// the focused `Screen` wrappers (see expo-router/build/ui/TabSlot.js:85),
// which breaks the flex chain for react-native-web: any nested
// `<ScrollView>` / `<FlashList>` refuses to shrink below its content
// height and stops scrolling on short viewports. We re-render the focused
// screen with a flex-shrink:1 style so the chain stays bounded.
const FIXED_SCREEN_STYLE: ViewStyle = {
  flex: 1,
  flexGrow: 1,
  flexShrink: 1,
  minHeight: 0,
  position: "relative",
  height: "100%",
};

const FIXED_SLOT_CONTAINER_STYLE: ViewStyle = {
  flex: 1,
  flexGrow: 1,
  flexShrink: 1,
  minHeight: 0,
};

function FixedTabSlot() {
  return useTabSlot({
    style: FIXED_SLOT_CONTAINER_STYLE,
    renderFn: (descriptor, { isFocused, loaded, detachInactiveScreens }) => {
      const options = descriptor.options as {
        lazy?: boolean;
        unmountOnBlur?: boolean;
        freezeOnBlur?: boolean;
      };
      const lazy = options.lazy ?? true;
      if (options.unmountOnBlur && !isFocused) return null;
      if (lazy && !loaded && !isFocused) return null;
      return (
        <Screen
          key={descriptor.route.key}
          enabled={detachInactiveScreens}
          activityState={isFocused ? 2 : 0}
          freezeOnBlur={options.freezeOnBlur}
          style={isFocused ? FIXED_SCREEN_STYLE : UNFOCUSED_SCREEN_STYLE}
        >
          {descriptor.render()}
        </Screen>
      );
    },
  });
}

const UNFOCUSED_SCREEN_STYLE: ViewStyle = {
  zIndex: -1,
  display: "none",
  flexShrink: 1,
  flexGrow: 0,
  position: "relative",
  height: "100%",
};

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>["name"];

type TabDef = {
  name: string;
  href: "/" | "/send" | "/receive" | "/buy" | "/settings";
  icon: IconName;
  label: string;
};

function isIndexActive(pathname: string): boolean {
  return pathname === "/" || pathname === "/(tabs)" || pathname === "";
}

function isActiveTab(pathname: string, href: TabDef["href"]): boolean {
  if (href === "/") {
    return isIndexActive(pathname);
  }
  return pathname === href;
}

export default function TabLayout() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const showRail = width >= MEDIUM_BREAKPOINT;
  const pathname = usePathname();

  const tabsStyle: StyleProp<ViewStyle> = {
    flex: 1,
    flexDirection: showRail ? "row" : "column",
    minHeight: 0,
  };


  const tabs: readonly TabDef[] = [
    { name: "index", href: "/", icon: "wallet", label: t("wallet.title") },
    {
      name: "send",
      href: "/send",
      icon: "arrow-up-bold",
      label: t("wallet.send"),
    },
    {
      name: "receive",
      href: "/receive",
      icon: "arrow-down-bold",
      label: t("wallet.receive"),
    },
    {
      name: "buy",
      href: "/buy",
      icon: "credit-card-plus-outline",
      label: t("wallet.buy"),
    },
    {
      name: "settings",
      href: "/settings",
      icon: "cog",
      label: t("wallet.settings"),
    },
  ];

  const renderTrigger = (tab: TabDef) => {
    const active = isActiveTab(pathname, tab.href);
    const color = active ? theme.colors.primary : theme.colors.textSecondary;

    if (showRail) {
      const indicatorBg = active
        ? theme.colors.primarySubtle
        : "transparent";
      const iconColor = active
        ? theme.colors.primarySubtleForeground
        : theme.colors.textSecondary;
      return (
        <TabTrigger
          key={tab.name}
          name={tab.name}
          href={tab.href}
          style={styles.railTab}
        >
          <View style={styles.railIconRow}>
            <View
              style={[
                styles.railIndicator,
                { backgroundColor: indicatorBg },
              ]}
            >
              <MaterialCommunityIcons
                name={tab.icon}
                size={RAIL_ICON_SIZE}
                color={iconColor}
              />
            </View>
          </View>
          <Text style={[styles.railLabel, { color }]} numberOfLines={1}>
            {tab.label}
          </Text>
        </TabTrigger>
      );
    }

    return (
      <TabTrigger
        key={tab.name}
        name={tab.name}
        href={tab.href}
        style={styles.bottomTab}
      >
        <MaterialCommunityIcons name={tab.icon} size={22} color={color} />
        <Text style={[styles.bottomLabel, { color }]}>{tab.label}</Text>
      </TabTrigger>
    );
  };

  return (
    <View
      style={[styles.container, { backgroundColor: theme.colors.background }]}
    >
      <Tabs style={tabsStyle}>
        {showRail ? (
          <>
            <TabList
              style={[
                styles.rail,
                {
                  backgroundColor: theme.colors.background,
                  borderRightColor: theme.colors.border,
                },
              ]}
            >
              {tabs.map(renderTrigger)}
            </TabList>
            <View style={styles.slotContainer}>
              <FixedTabSlot />
            </View>
          </>
        ) : (
          <>
            <View style={styles.slotContainer}>
              <FixedTabSlot />
            </View>
            <TabList
              style={[
                styles.bottomList,
                {
                  backgroundColor: theme.colors.background,
                  borderTopColor: theme.colors.border,
                },
              ]}
            >
              {tabs.map(renderTrigger)}
            </TabList>
          </>
        )}
      </Tabs>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 0,
  },

  // ── Navigation rail (>= 600px) ────────────────────────────────────────────
  rail: {
    width: RAIL_WIDTH,
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "flex-start",
    borderRightWidth: 1,
    paddingTop: 16,
    paddingBottom: 16,
    gap: 4,
  },
  railTab: {
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 12,
    paddingBottom: 12,
  },
  railIconRow: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  railIndicator: {
    width: RAIL_INDICATOR_WIDTH,
    height: RAIL_INDICATOR_HEIGHT,
    borderRadius: RAIL_INDICATOR_HEIGHT / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  railLabel: {
    fontSize: 12,
    fontWeight: "500",
    marginTop: 4,
    textAlign: "center",
  },

  // Wrapper around <TabSlot /> that owns the flex sizing. Without this the
  // default TabSlot style (`flexShrink: 0`) prevents react-native-web's
  // `<ScrollView>` from receiving a bounded height. Always full width and
  // top-aligned so screens fill the available area on every viewport.
  slotContainer: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    alignSelf: "stretch",
  },

  // ── Bottom tab bar (< 600px) ──────────────────────────────────────────────
  bottomList: {
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    borderTopWidth: 1,
    paddingVertical: 8,
    paddingBottom: 12,
    paddingHorizontal: 4,
  },
  bottomTab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 4,
    paddingHorizontal: 4,
    minWidth: 0,
  },
  bottomLabel: {
    fontSize: 11,
    marginTop: 2,
    fontWeight: "500",
  },
});
