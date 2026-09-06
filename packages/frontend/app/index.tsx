/**
 * Entry screen — Oxy-first onboarding (spec §4.2).
 *
 * Decides the entry route from Oxy auth state + the on-device identity:
 *   signed out          -> "Sign in with Oxy"
 *   signed in, keyless  -> "Set up your Oxy ID"
 *   signed in, native   -> derive the identity wallet -> PIN gate -> (tabs)
 *   no published key    -> ask the phone to publish its watch-only key once
 *
 * This screen is the sole authority for the swap; it renders neutral in-place
 * branches and never navigates a child across the boundary.
 */

import { useCallback, useState } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { Redirect, useFocusEffect } from "expo-router";
import { useAuth } from "@oxyhq/services";
import { useWalletStore, type IdentityInitResult } from "../src/wallet/wallet-store";
import { useLockStore } from "../src/wallet/lock-store";
import { hasPin } from "../src/storage/secure-store";
import { decideEntryRoute } from "../src/wallet/entry-route";
import { Button } from "../src/ui/components/Button";
import { CreateOxyIdView } from "../src/ui/components/CreateOxyIdView";
import { t } from "../src/i18n";

export default function IndexScreen() {
  const { isAuthResolved, isAuthenticated, signIn } = useAuth();
  const initializeFromIdentity = useWalletStore((s) => s.initializeFromIdentity);
  const initialized = useWalletStore((s) => s.initialized);
  const markNoPinUnlocked = useLockStore((s) => s.markNoPinUnlocked);
  const resolveInitialLock = useLockStore((s) => s.resolveInitialLock);

  const [identityInit, setIdentityInit] = useState<IdentityInitResult | null>(null);
  const [hasPinConfigured, setHasPinConfigured] = useState<boolean | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const boot = async () => {
        if (!isAuthResolved || !isAuthenticated) return;
        // Probe exactly when there is no result. `identityInit` is therefore a
        // DEPENDENCY and not just state this writes: the link-device retry
        // clears it, and that alone re-runs this. A separate attempt counter
        // would be a dependency the body never reads — which is the shape that
        // silently stops re-running the day someone tidies the array.
        if (identityInit !== null) return;
        try {
          const pinSet = await hasPin();
          const result: IdentityInitResult = initialized
            ? "initialized"
            : await initializeFromIdentity(() => {});
          if (cancelled) return;
          setHasPinConfigured(pinSet);
          setIdentityInit(result);
          if (result === "initialized") {
            if (!pinSet) markNoPinUnlocked();
            else resolveInitialLock(pinSet);
          } else {
            markNoPinUnlocked();
          }
        } catch (err: unknown) {
          if (!cancelled) {
            setErrorMsg(err instanceof Error ? err.message : t("index.error.load"));
          }
        }
      };
      void boot();
      return () => {
        cancelled = true;
      };
    }, [
      isAuthResolved,
      isAuthenticated,
      initialized,
      initializeFromIdentity,
      markNoPinUnlocked,
      resolveInitialLock,
      identityInit,
    ]),
  );

  if (errorMsg) {
    return (
      <View className="flex-1 bg-background items-center justify-center px-6">
        <Text className="text-destructive text-base text-center mb-4">{errorMsg}</Text>
        <Text className="text-muted-foreground text-sm text-center">{t("index.error.help")}</Text>
      </View>
    );
  }

  const route = decideEntryRoute({ isAuthResolved, isAuthenticated, identityInit, hasPinConfigured });

  switch (route.kind) {
    case "ready":
      return <Redirect href="/(tabs)" />;
    case "needs-pin":
      return <Redirect href="/onboarding/pin-setup" />;
    case "signin":
      return (
        <View className="flex-1 bg-background items-center justify-center px-8">
          <Text className="text-foreground text-2xl text-center mb-3">{t("onboarding.signInTitle")}</Text>
          <Text className="text-muted-foreground text-base text-center mb-8">{t("onboarding.signInSubtitle")}</Text>
          <View className="w-full">
            <Button title={t("pay.signIn")} onPress={() => void signIn()} variant="primary" size="lg" />
          </View>
        </View>
      );
    case "create-identity":
      return <CreateOxyIdView />;
    // The one genuinely browser-shaped state, and it is a missing INPUT rather
    // than a host: the address tree derives from a seed produced by HKDF over
    // the on-device identity private key, so this surface can only show the
    // wallet once the phone has published the public half. Once it has,
    // `initializeFromIdentity` returns "initialized" here exactly as on the
    // phone and the browser goes to the same tabs — there is no web branch
    // beyond this one.
    //
    // Rendered IN PLACE, like every other branch on this screen. The version
    // that redirected to `/@you` landed the browser on a page whose back arrow
    // falls through to `router.replace("/(tabs)")`, and since a route group adds
    // no URL segment both answer `/` — so the entry decision re-ran and bounced
    // back, flashing a wallet UI with no wallet behind it.
    case "link-device":
      return (
        <View className="flex-1 bg-background items-center justify-center px-8">
          <Text className="text-foreground text-2xl text-center mb-3">
            {t("linkDevice.title")}
          </Text>
          <Text className="text-muted-foreground text-base text-center mb-8 leading-6">
            {t("linkDevice.subtitle")}
          </Text>
          <View className="w-full">
            <Button
              title={t("linkDevice.retry")}
              onPress={() => setIdentityInit(null)}
              variant="secondary"
              size="lg"
            />
          </View>
        </View>
      );

    case "loading":
    default:
      return (
        <View className="flex-1 bg-background items-center justify-center">
          <ActivityIndicator size="large" color="#9ffb50" />
          <Text className="text-muted-foreground text-sm mt-4">{t("index.loading")}</Text>
        </View>
      );
  }
}
