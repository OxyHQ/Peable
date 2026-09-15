/**
 * Tab layout — one tab navigator for iOS, Android, web and Electron.
 *
 * The bar is Bloom, rendered through the navigator's `tabBar` slot:
 *
 *   - a wide browser window  -> Bloom `Rail`, beside the screens
 *                               (`tabBarPosition: "left"`)
 *   - everything else        -> Bloom's floating `TabBar` pill
 *
 * It replaced two layouts: native `NativeTabs` (the platform's own bar) and a
 * hand-built headless-tabs rail/bottom-list for web. The destinations, their
 * order and their labels come from `src/ui/navigation/tabs.tsx`, so rail and
 * bar cannot disagree. Harvested from FAIRWallet (FairCoinOfficial/FAIRWallet#9);
 * the capability gate below is Peable's own.
 *
 * The bar FLOATS over the screens. A tab screen keeps its last row clear of it
 * with `useTabScreenBottomInset()`.
 *
 * `TabBarMinimizeProvider` wraps the navigator rather than sitting inside it:
 * it has to be an ancestor of both the screens that could drive the minimize
 * signal and the bar that reads it.
 */

import { View } from "react-native";
import { Tabs } from "expo-router/tabs";
import { TabBarMinimizeProvider } from "@oxy.so/bloom/tab-bar";
import { useTheme } from "@oxy.so/bloom/theme";
import { WalletRail } from "../../src/ui/navigation/WalletRail";
import { WalletTabBar } from "../../src/ui/navigation/WalletTabBar";
import { WALLET_TABS, useWalletNavLayout, type WalletTabName } from "../../src/ui/navigation/tabs";
import { SignInView } from "../../src/ui/components/SignInView";
import { hasIdentityKeystore } from "../../src/wallet/keystore";
import { useWalletCapability } from "../../src/wallet/use-wallet-capability";

/**
 * Send signs and Buy delivers to an address derived from the wallet's xpub, so
 * a read-only host does not offer them. Their screens also redirect a
 * read-only visitor home, for a typed URL.
 */
const READ_ONLY_HIDDEN_TABS: ReadonlySet<WalletTabName> = new Set(["send", "buy"]);

export default function TabLayout() {
  const theme = useTheme();
  const layout = useWalletNavLayout();
  const capability = useWalletCapability();

  // The gate belongs where the group is ENTERED, so it holds no matter who
  // navigates here — `[username].tsx`'s back handler and `NotFoundScreen` both
  // `router.replace("/(tabs)")` with no check of their own.
  //
  // It asks about CAPABILITY, not `initialized`: a browser can never initialize
  // the identity wallet, so gating on `initialized` kept every web visitor out
  // of the shell. `read-only` is admitted and each tab renders its keyless
  // branch. `pending` renders nothing, so a reload on `/settings` is not decided
  // before auth resolves.
  //
  // `none` on a KEYLESS host means signed out, and renders sign-in IN PLACE. It
  // must not `<Redirect href="/" />`: inside this group `/` is `(tabs)/index`,
  // the layout renders the redirect again, forever, and React aborts with error
  // #185 — what `peable.to/settings` once showed signed out.
  //
  // A KEYSTORE host is not gated here, as it never was: it reaches the shell
  // only through `app/index.tsx`, and `lockWallet` tears the wallet down (so
  // `initialized` goes false) while the lock overlay covers the shell. Gating
  // it would swap the tabs for sign-in underneath the PIN pad.
  if (!hasIdentityKeystore()) {
    if (capability === "pending") {
      return <View style={{ flex: 1, backgroundColor: theme.colors.background }} />;
    }
    if (capability === "none") {
      return <SignInView />;
    }
  }

  const tabs =
    capability === "read-only" ? WALLET_TABS.filter((name) => !READ_ONLY_HIDDEN_TABS.has(name)) : WALLET_TABS;

  return (
    <TabBarMinimizeProvider>
      <Tabs
        tabBar={(props) =>
          layout === "rail" ? <WalletRail {...props} tabs={tabs} /> : <WalletTabBar {...props} tabs={tabs} />
        }
        screenOptions={{
          headerShown: false,
          tabBarPosition: layout === "rail" ? "left" : "bottom",
          sceneStyle: { backgroundColor: theme.colors.background },
        }}
      >
        <Tabs.Screen name="index" />
        <Tabs.Screen name="map" />
        <Tabs.Screen name="send" />
        <Tabs.Screen name="receive" />
        <Tabs.Screen name="buy" />
        <Tabs.Screen name="settings" />
      </Tabs>
    </TabBarMinimizeProvider>
  );
}
