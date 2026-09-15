/**
 * The wallet's tab destinations and the one decision about how to show them.
 *
 * `app/(tabs)/_layout.tsx` is a single tab navigator on every platform, and its
 * `tabBar` slot renders EITHER Bloom's `Rail` (a wide browser window) or Bloom's
 * floating `TabBar` (phones, tablets, a narrow browser). Both read the tab list
 * from here, so the two cannot drift apart the way the old native `NativeTabs`
 * layout and the hand-built web rail did.
 */

import { Platform, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useTabBarFootprint } from "@oxy.so/bloom/tab-bar";
import { t } from "../../i18n";

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>["name"];

export type WalletTabName = "index" | "map" | "send" | "receive" | "buy" | "settings";

interface WalletTabDef {
  /** i18n key of the label under the glyph. */
  labelKey: string;
  /** Outline glyph, shown while the tab is not selected. */
  icon: IconName;
  /** Filled glyph, shown while it is. */
  activeIcon: IconName;
}

const TAB_DEFS: Record<WalletTabName, WalletTabDef> = {
  index: { labelKey: "wallet.title", icon: "wallet-outline", activeIcon: "wallet" },
  map: { labelKey: "wallet.places", icon: "map-outline", activeIcon: "map" },
  send: { labelKey: "wallet.send", icon: "arrow-up-bold-outline", activeIcon: "arrow-up-bold" },
  receive: {
    labelKey: "wallet.receive",
    icon: "arrow-down-bold-outline",
    activeIcon: "arrow-down-bold",
  },
  buy: {
    labelKey: "wallet.buy",
    icon: "credit-card-plus-outline",
    activeIcon: "credit-card-plus",
  },
  settings: { labelKey: "wallet.settings", icon: "cog-outline", activeIcon: "cog" },
};

/**
 * Visible tabs, in order. Every file in `app/(tabs)` is a route of the
 * navigator; only these get a bar/rail entry.
 *
 * The sets differ on purpose and match what each platform had before. Native
 * opens Send/Receive as a sheet from the home and has the Places map; the web
 * map is a "mobile only" placeholder, so a browser gets Send and Receive as
 * destinations instead.
 */
export const WALLET_TABS: readonly WalletTabName[] =
  Platform.OS === "web"
    ? ["index", "send", "receive", "buy", "settings"]
    : ["index", "map", "buy", "settings"];

export function walletTabLabel(name: WalletTabName): string {
  return t(TAB_DEFS[name].labelKey);
}

export function WalletTabIcon({
  name,
  active,
  color,
  size,
}: {
  name: WalletTabName;
  active: boolean;
  color: string;
  size: number;
}) {
  const def = TAB_DEFS[name];
  // Colored HERE, not by the bar: Bloom tints a glyph by injecting `fill`, and
  // MaterialCommunityIcons paints from `color`, so an untinted glyph would
  // never light up.
  return <MaterialCommunityIcons name={active ? def.activeIcon : def.icon} size={size} color={color} />;
}

/** Below this window width a browser gets the bottom bar instead of the rail. */
export const RAIL_MIN_WIDTH = 600;

export type WalletNavLayout = "rail" | "bar";

/**
 * Rail only in a browser window wide enough for one. Native keeps the bottom
 * bar at every size, tablets included — the bar caps its own width there.
 */
export function useWalletNavLayout(): WalletNavLayout {
  const { width } = useWindowDimensions();
  return Platform.OS === "web" && width >= RAIL_MIN_WIDTH ? "rail" : "bar";
}

/**
 * Bottom padding a tab screen's scroll content (or fixed footer) needs.
 *
 * Bloom's `TabBar` FLOATS over the screen rather than reserving space the way
 * `NativeTabs` did, so the last row of every tab would sit under the pill
 * without this. The footprint already includes the bottom safe-area inset. The
 * rail takes no vertical space, so there it is just the safe-area inset.
 */
export function useTabScreenBottomInset(): number {
  const layout = useWalletNavLayout();
  const footprint = useTabBarFootprint();
  const insets = useSafeAreaInsets();
  return layout === "bar" ? footprint : insets.bottom;
}
