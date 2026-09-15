/**
 * Entry screen — Oxy-first onboarding (spec §4.2).
 *
 * Decides the entry route from Oxy auth state + the on-device identity:
 *   signed out          -> "Sign in with Oxy"
 *   signed in, keyless  -> "Set up your Oxy ID"
 *   signed in, native   -> derive the identity wallet -> PIN gate -> (tabs)
 *   no keystore         -> (tabs), read-only: activity, receive code, settings
 *
 * This screen is the sole authority for the swap: it renders the pre-wallet
 * branches (sign in, create an Oxy ID) in place and sends the two that have a
 * wallet shell to show — full and read-only — into `(tabs)`.
 */

import { useCallback, useState } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { Redirect, useFocusEffect } from "expo-router";
import { useAuth } from "@oxy.so/services";
import { useWalletStore, type IdentityInitResult } from "../src/wallet/wallet-store";
import { useLockStore } from "../src/wallet/lock-store";
import { hasPin } from "../src/storage/secure-store";
import { decideEntryRoute } from "../src/wallet/entry-route";
import { SignInView } from "../src/ui/components/SignInView";
import { CreateOxyIdView } from "../src/ui/components/CreateOxyIdView";
import { t } from "../src/i18n";

export default function IndexScreen() {
  const { isAuthResolved, isAuthenticated } = useAuth();
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
      return <SignInView />;
    case "create-identity":
      return <CreateOxyIdView />;
    // No keystore here, so no identity seed, so no signing — but the SHELL is
    // still the right place: `(tabs)` admits the `read-only` capability
    // (`src/wallet/capability.ts`) and each tab renders what needs no key.
    //
    // This used to render the read-only view IN PLACE, because `(tabs)` then
    // admitted only an initialized wallet and redirecting there bounced straight
    // back to `/`. In place meant outside the shell: a web visitor lost the
    // navigation rail, Settings and every other tab. The bounce is gone because
    // the gate now asks about capability, not about `initialized`.
    case "read-only":
      return <Redirect href="/(tabs)" />;
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
