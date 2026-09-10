/**
 * Root layout for FAIRWallet.
 *
 * Theme loading strategy (same pattern as Alia):
 * 1. SplashScreen.preventAutoHideAsync() at module level
 * 2. Load persisted theme mode from async storage
 * 3. Mount BloomThemeProvider with correct mode (applies native color scheme
 *    synchronously during render via Bloom 0.1.31)
 * 4. Hide splash screen once ready
 *
 * This ensures no flash of wrong colors on native UI chrome.
 */

import "../src/crypto-polyfill";
import "../global.css";

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus, Platform, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useFonts } from "expo-font";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { KeyboardProvider as NativeKeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { OxyProvider } from "@oxy.so/services";
import { BloomThemeProvider, useBloomTheme } from "@oxy.so/bloom/theme";
import type { ThemeMode } from "@oxy.so/bloom/theme";
import { ImageResolverProvider } from "@oxy.so/bloom/image-resolver";
import { parseFairCoinURI } from "@fairco.in/core";
import { parsePaymentRequest } from "../src/pay/payment-request";
import { queryClient } from "../src/services/query-client";
import { oxyServices } from "../src/services/oxy-services";
import { OXY_CLIENT_ID, OXY_AUTH_REDIRECT_URI } from "../src/config";
import { useExplorerRealtime } from "../src/hooks/useExplorerRealtime";
import { useWalletStore } from "../src/wallet/wallet-store";
import { useLockStore } from "../src/wallet/lock-store";
import { LockGate } from "../src/ui/components/LockGate";
import { getAutoLockTimeout } from "../src/storage/secure-store";
import { initLanguage } from "../src/i18n";
import { useLanguageStore } from "../src/i18n/store";
import { getItemAsync, setItemAsync } from "../src/storage/kv-store";
import { startTxNotifier } from "../src/services/tx-notifier";
import { startSyncNotifier } from "../src/services/sync-notifier";
import { startPushRegistration } from "../src/services/push-registration";
import { handleIncomingPush } from "../src/services/push-handler";
import { registerBackgroundSync } from "../src/services/background-sync";

// react-native-keyboard-controller ships no web build — its KeyboardControllerView
// is a native-only component that breaks the flex height chain on web and leaves
// all scrollables with 0 bounded height. Web has no virtual keyboard anyway, so
// we pass children straight through.
const KeyboardProvider =
  Platform.OS === "web"
    ? ({ children }: { children: React.ReactNode }) => <>{children}</>
    : NativeKeyboardProvider;

// Module-level initialization. Resolves the persisted or device language,
// then syncs the reactive store so React components see the correct value.
const languageInitPromise = initLanguage()
  .then(() => {
    useLanguageStore.getState().hydrate();
  })
  .catch(() => {
    // Defaults from `initLanguage` remain in place; `hydrate` is still safe.
    useLanguageStore.getState().hydrate();
  });

// Start watching wallet transactions for incoming-payment alerts. Must run
// before any wallet state is hydrated so the subscriber sees every new tx
// beyond the initial snapshot.
startTxNotifier();

// Mirror sync progress into an ongoing notification while the wallet syncs.
startSyncNotifier();

// Keep the background-notification subscription in sync with the wallet + prefs
// (registers the watch-only xpub when the user enables payment notifications).
// No-op on web/electron and until the user opts in. Safe at module scope: the
// native modules it needs are required lazily inside the call.
startPushRegistration();

// Best-effort background task registration for wake-up payment alerts.
// Safe on platforms that don't support background tasks (web / electron).
void registerBackgroundSync();

// Prevent splash from auto-hiding — we hide it manually after loading
SplashScreen.preventAutoHideAsync().catch(() => {
  // Ignore if activity not available yet (Android dev client reload)
});

const THEME_MODE_KEY = "fairwallet_theme_mode";

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useDeepLinkHandler() {
  const router = useRouter();
  const initialized = useWalletStore((s) => s.initialized);
  const locked = useLockStore((s) => s.locked);
  const queueDeepLink = useLockStore((s) => s.queueDeepLink);
  const consumePendingDeepLink = useLockStore(
    (s) => s.consumePendingDeepLink,
  );

  const navigateFromUrl = useCallback(
    (url: string) => {
      // An `peable://pay?...` request routes to the approve-pay screen. Parse +
      // validate here so we only ever push the approve screen for a well-formed
      // request; the screen re-derives the same fields from its route params.
      const payment = parsePaymentRequest(url);
      if (payment) {
        router.push({
          pathname: "/pay/[intent]",
          params: {
            intent: payment.intentId,
            secret: payment.clientSecret,
            address: payment.address,
            amount: payment.amount.toString(),
            network: payment.network,
          },
        });
        return;
      }
      const parsed = parseFairCoinURI(url);
      if (parsed) {
        router.push({
          pathname: "/(tabs)/send",
          params: { address: parsed.address, amount: parsed.amount ?? "" },
        });
      }
    },
    [router],
  );

  const handleDeepLink = useCallback(
    (event: { url: string }) => {
      if (!event.url) return;
      // Never navigate into an authenticated screen while locked or before the
      // wallet is initialized (review finding C1). N-10: instead of dropping
      // the URL, queue it on the lock store so the unlock path can replay
      // it — losing a `faircoin:` payment URI just because the app was
      // locked is poor UX.
      if (!initialized || locked) {
        queueDeepLink(event.url);
        return;
      }
      navigateFromUrl(event.url);
    },
    [initialized, locked, queueDeepLink, navigateFromUrl],
  );

  // Register the URL listener in an effect with proper teardown (review finding
  // M6: the previous ref-in-render registration never removed the listener,
  // leaking a subscription on every remount).
  useEffect(() => {
    const subscription = Linking.addEventListener("url", handleDeepLink);
    let cancelled = false;
    Linking.getInitialURL().then((url) => {
      if (url && !cancelled) handleDeepLink({ url });
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [handleDeepLink]);

  // N-10: once the app becomes both initialized AND unlocked, replay any
  // deep link captured while we were locked. The 5-minute freshness window
  // (default in `consumePendingDeepLink`) avoids replaying a URL that's
  // been sitting around since a previous session.
  useEffect(() => {
    if (!initialized || locked) return;
    const pending = consumePendingDeepLink();
    if (pending) navigateFromUrl(pending);
  }, [initialized, locked, consumePendingDeepLink, navigateFromUrl]);
}

/**
 * Route a silent payment push to the on-device handler. The server sends a
 * data-only push carrying `{ txid, event }` (never an amount, spec §4.2); this
 * listener wakes the handler, which syncs the txid and posts a LOCAL
 * notification with the amount composed on-device.
 *
 * Our own local notifications (received / sent / sync) carry no `txid`, so the
 * guard below skips them — this only acts on server pushes.
 */
function usePushNotificationHandler() {
  useEffect(() => {
    const subscription = Notifications.addNotificationReceivedListener(
      (notification) => {
        const data = notification.request.content.data;
        const txid = data?.txid;
        if (typeof txid !== "string" || txid.length === 0) return;
        const event =
          typeof data?.event === "string" ? data.event : "incoming_confirmed";
        void handleIncomingPush({ txid, event });
      },
    );
    return () => {
      subscription.remove();
    };
  }, []);
}

function useAutoLock() {
  const initialized = useWalletStore((s) => s.initialized);
  const lockWallet = useWalletStore((s) => s.lockWallet);
  const lock = useLockStore((s) => s.lock);
  const backgroundTime = useRef<number | null>(null);

  const handleStateChange = useCallback(
    (state: AppStateStatus) => {
      if (!initialized) return;
      if (state === "background" || state === "inactive") {
        backgroundTime.current = Date.now();
      } else if (state === "active" && backgroundTime.current !== null) {
        const elapsed = Date.now() - backgroundTime.current;
        backgroundTime.current = null;
        getAutoLockTimeout().then((min) => {
          // Re-lock via the lock store so the overlay covers every screen, not
          // just by navigating to a route the user could swipe away from.
          if (elapsed > min * 60_000) {
            lock();
            // Zeroize cached private keys and stop SPV while locked (M1). The
            // lock overlay's unlock path re-initializes the wallet on a correct
            // PIN, so this is non-destructive.
            lockWallet();
          }
        });
      }
    },
    [initialized, lock, lockWallet],
  );

  // Attach the AppState listener in an effect with teardown (review finding M6).
  useEffect(() => {
    const subscription = AppState.addEventListener("change", handleStateChange);
    return () => {
      subscription.remove();
    };
  }, [handleStateChange]);
}

// ---------------------------------------------------------------------------
// Root layout
// ---------------------------------------------------------------------------

export default function RootLayout() {
  useDeepLinkHandler();
  useAutoLock();
  usePushNotificationHandler();

  const [fontsLoaded] = useFonts({
    "Phudu-Light": require("../assets/fonts/Phudu-Light.ttf"),
    "Phudu-Regular": require("../assets/fonts/Phudu-Regular.ttf"),
    "Phudu-Bold": require("../assets/fonts/Phudu-Bold.ttf"),
    "Phudu-Black": require("../assets/fonts/Phudu-Black.ttf"),
  });

  const [mode, setMode] = useState<ThemeMode>("dark");
  const [themeReady, setThemeReady] = useState(false);
  const [languageReady, setLanguageReady] = useState(false);
  const language = useLanguageStore((s) => s.language);

  useEffect(() => {
    let cancelled = false;
    getItemAsync(THEME_MODE_KEY).then((stored) => {
      if (cancelled) return;
      if (stored === "light" || stored === "dark" || stored === "system") {
        setMode(stored);
      }
      setThemeReady(true);
    });
    languageInitPromise.then(() => {
      if (!cancelled) setLanguageReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleModeChange = useCallback((next: ThemeMode) => {
    setMode(next);
    setItemAsync(THEME_MODE_KEY, next);
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <BloomThemeProvider
            mode={mode}
            colorPreset="blue"
            onModeChange={handleModeChange}
            fonts={false}
          >
            <OxyProvider
              oxyServices={oxyServices}
              clientId={OXY_CLIENT_ID}
              authRedirectUri={OXY_AUTH_REDIRECT_URI}
              storageKeyPrefix="peable"
              queryClient={queryClient}
            >
              <ImageResolverProvider
                value={(id, variant) => oxyServices.getFileDownloadUrl(id, variant)}
              >
                <BottomSheetModalProvider>
                  <AppContent
                    key={language}
                    ready={fontsLoaded && themeReady && languageReady}
                  />
                </BottomSheetModalProvider>
              </ImageResolverProvider>
            </OxyProvider>
          </BloomThemeProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

function AppContent({ ready }: { ready: boolean }) {
  const { theme } = useBloomTheme();

  // Keep the Explorer realtime socket alive (foreground-gated) so the home
  // Overview's network stats tick live off the WebSocket.
  useExplorerRealtime();

  // Hide splash screen once fonts and theme are loaded
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  return (
    <View style={{ flex: 1 }}>
      <StatusBar style={theme.isDark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.background },
          headerTintColor: theme.colors.tint,
          headerTitleStyle: { color: theme.colors.text },
          contentStyle: { backgroundColor: theme.colors.background },
          animation: "slide_from_right",
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false }} />
        <Stack.Screen name="lock" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="masternode" options={{ headerShown: false, presentation: "modal" }} />
        <Stack.Screen name="pockets" options={{ headerShown: false, presentation: "modal" }} />
        <Stack.Screen name="contacts" options={{ headerShown: false, presentation: "modal" }} />
        <Stack.Screen name="export-key" options={{ headerShown: false, presentation: "modal" }} />
        <Stack.Screen name="coin-control" options={{ headerShown: false, presentation: "modal" }} />
        <Stack.Screen name="peers" options={{ headerShown: false, presentation: "modal" }} />
        <Stack.Screen name="chain" options={{ headerShown: false, presentation: "modal" }} />
        <Stack.Screen name="language" options={{ headerShown: false, presentation: "modal" }} />
        <Stack.Screen name="notifications-settings" options={{ headerShown: false, presentation: "modal" }} />
        <Stack.Screen name="transaction/[txid]" options={{ headerShown: false }} />
        <Stack.Screen name="pay/[intent]" options={{ headerShown: false }} />
        <Stack.Screen name="buy" options={{ headerShown: false }} />
        {/* Public `/@username` profile — see `app/[username].tsx`. Also the
            catch-all for unknown single-segment URLs, which it 404s itself. */}
        <Stack.Screen name="[username]" options={{ headerShown: false }} />
      </Stack>
      {/* Full-screen lock overlay: covers every authenticated route while the
          app is locked so no screen can be reached behind it (finding C1). */}
      <LockGate />
    </View>
  );
}
