/**
 * The public `/@username` profile — "Make a Peable to John on peable.to/@john".
 *
 * ROUTING. expo-router has no partial-segment match, so there is no way to
 * write a route file that matches only `@`-prefixed paths. The technique here
 * is Mention's (`app/(app)/[username]/_layout.tsx` +
 * `app/(app)/[username]/index.tsx` in `~/Oxy/Mention/packages/frontend`): an
 * ORDINARY dynamic segment whose value carries the `@`, with the `@` checked
 * inside. That makes this file the app's catch-all for every unknown
 * single-segment URL as well, which is why a segment `parseProfileHandle`
 * rejects renders the app's own 404 — the same body `app/+not-found.tsx`
 * renders — instead of a blank screen or a pointless identity lookup.
 *
 * DATA. The Oxy profile lookup is anonymous: `getProfileByUsername` sends no
 * bearer when there is no session (`HttpService.getAuthHeader` returns null),
 * and `/profiles/username/:username` is public. A payer arriving from a shared
 * link therefore sees the person before deciding whether to sign in at all.
 *
 * PAYING. What the CTA may offer is `decideProfilePayAction`'s call — read the
 * table there; the two constraints that shape it are that the wallet is
 * native-only (a browser has no on-device identity key to derive a seed from)
 * and that pay-by-@username is testnet-only until finding F-1 is fixed.
 * Reserving the address happens HERE, on the press, and only then: a
 * reservation advances the recipient's cursor whether or not it is ever paid,
 * and the gateway allows six per (sender, recipient) per ten minutes, so
 * reserving on page load would spend that budget on link clicks.
 */

import { useCallback, useState } from "react";
import { View, Text, ActivityIndicator, Platform, Linking } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import Constants from "expo-constants";
import { useAuth } from "@oxyhq/services";
import { isNotFoundError } from "@oxyhq/core";
import { SafeAreaView } from "../src/ui/safe-area-view";
import { NotFoundScreen } from "../src/ui/components/NotFoundScreen";
import { ScreenHeader } from "../src/ui/components/ScreenHeader";
import { UserAvatar } from "../src/ui/components/UserAvatar";
import { ProfileQRCard } from "../src/ui/components/ProfileQRCard";
import { Button } from "../src/ui/components/Button";
import { oxyServices } from "../src/services/oxy-services";
import { reserveNextSocialAddress, KeylessRecipientError } from "../src/services/gateway-client";
import { useWalletStore } from "../src/wallet/wallet-store";
import {
  parseProfileHandle,
  decideProfilePayAction,
} from "../src/pay/profile-route";
import { FONT_PHUDU_BLACK } from "../src/utils/fonts";
import { t } from "../src/i18n";

/** Matches ReceiveSheet's address QR, so the two read as one app. */

/** Stripped for display only; the QR always encodes the full URL. */

/** How long a resolved profile stays fresh — identities change rarely. */
const PROFILE_STALE_TIME_MS = 5 * 60 * 1000;

const AVATAR_SIZE = 96;

/**
 * The app's own URL scheme, read from `app.json` through the bundled manifest
 * rather than restated here. `scheme` is an array (`["peable", "faircoin"]`);
 * the first entry is the app's own. Absent manifest ⇒ no "open the app"
 * button, rather than a guessed URL.
 */
function appScheme(): string | null {
  const scheme = Constants.expoConfig?.scheme;
  if (typeof scheme === "string") return scheme;
  if (Array.isArray(scheme) && typeof scheme[0] === "string") return scheme[0];
  return null;
}

export default function ProfileRoute() {
  const params = useLocalSearchParams<{ username?: string | string[] }>();
  const handle = parseProfileHandle(params.username);

  // Not an `@handle`: this route is also the catch-all for unknown
  // single-segment URLs, and those are 404s, not profiles.
  if (handle === null) return <NotFoundScreen />;

  return <ProfileScreen handle={handle} />;
}

function ProfileScreen({ handle }: { handle: string }) {
  const router = useRouter();
  const { user, isAuthenticated, isAuthResolved, signIn } = useAuth();
  const walletInitialized = useWalletStore((s) => s.initialized);
  const network = useWalletStore((s) => s.network);

  const [reserving, setReserving] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const {
    data: profile,
    isPending,
    error,
  } = useQuery({
    queryKey: ["oxyProfileByUsername", handle],
    queryFn: () => oxyServices.getProfileByUsername(handle),
    staleTime: PROFILE_STALE_TIME_MS,
    // A missing handle is an answer, not a transient failure — retrying a 404
    // only delays the not-found state behind another round trip. Everything
    // else keeps the client-wide single retry (`services/query-client.ts`);
    // this predicate REPLACES that count, so it has to restate the bound.
    retry: (failureCount, err: unknown) => failureCount < 1 && !isNotFoundError(err),
  });

  const handleBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)");
  }, [router]);

  /**
   * Reserve this recipient's next fresh social-receive address, then hand the
   * resolved identity AND that address to the send screen. Both travel as
   * route params so `SendSheet` needs no async work of its own — see its
   * `recipient` prop.
   */
  const handleSend = useCallback(async () => {
    if (!profile) return;
    setPayError(null);
    setReserving(true);
    try {
      const reservation = await reserveNextSocialAddress(profile.username, network);
      router.push({
        pathname: "/(tabs)/send",
        params: {
          address: reservation.address,
          recipientId: profile.id,
          recipientUsername: profile.username,
          recipientDisplayName: profile.name.displayName ?? "",
          recipientAvatarFileId: profile.avatar ?? "",
        },
      });
    } catch (e: unknown) {
      setPayError(
        e instanceof KeylessRecipientError
          ? t("profile.error.keyless", { username: profile.username })
          : t("profile.error.reserve"),
      );
    } finally {
      setReserving(false);
    }
  }, [profile, network, router]);

  // Empty authority (three slashes) so the handle is the PATH and not the host:
  // `peable:///@john` is the form `Linking.createURL("/@john")` produces on
  // native, and the form expo-router's linking resolves back to this route.
  const handleOpenApp = useCallback(() => {
    const scheme = appScheme();
    if (scheme) void Linking.openURL(`${scheme}:///@${handle}`);
  }, [handle]);

  const handleGoHome = useCallback(() => {
    router.replace("/(tabs)");
  }, [router]);

  const handleSignIn = useCallback(() => {
    void signIn();
  }, [signIn]);

  if (isPending) {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={["top", "bottom", "left", "right"]}>
        <ScreenHeader title={`@${handle}`} onBack={handleBack} />
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" />
        </View>
      </SafeAreaView>
    );
  }

  if (!profile) {
    const missing = isNotFoundError(error);
    return (
      <SafeAreaView className="flex-1 bg-background" edges={["top", "bottom", "left", "right"]}>
        <ScreenHeader title={`@${handle}`} onBack={handleBack} />
        <View className="flex-1 items-center justify-center px-8">
          <Text
            className="text-foreground text-center mb-3"
            style={{ fontFamily: FONT_PHUDU_BLACK, fontSize: 24 }}
          >
            {missing ? t("profile.notFound.title", { username: handle }) : t("profile.error.title")}
          </Text>
          <Text className="text-muted-foreground text-base text-center mb-8 leading-6">
            {missing ? t("profile.notFound.description") : t("profile.error.description")}
          </Text>
          <View className="w-full max-w-xs">
            <Button title={t("notFound.goHome")} onPress={handleGoHome} variant="secondary" size="lg" />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  const displayName = profile.name.displayName ?? profile.username;
  const action = decideProfilePayAction({
    isWeb: Platform.OS === "web",
    isAuthResolved,
    isAuthenticated,
    isSelf: user?.id === profile.id,
    walletInitialized,
    network,
  });

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top", "bottom", "left", "right"]}>
      <ScreenHeader title={`@${profile.username}`} onBack={handleBack} />

      <View className="flex-1 items-center px-8 pt-6">
        <UserAvatar
          avatarFileId={profile.avatar ?? undefined}
          displayName={profile.name.displayName}
          username={profile.username}
          size={AVATAR_SIZE}
        />

        <Text
          className="text-foreground text-center mt-5"
          style={{ fontFamily: FONT_PHUDU_BLACK, fontSize: 26 }}
          numberOfLines={2}
        >
          {displayName}
        </Text>
        <Text className="text-muted-foreground text-base mt-1">@{profile.username}</Text>

        {profile.description ? (
          <Text className="text-muted-foreground text-sm text-center mt-4 leading-5">
            {profile.description}
          </Text>
        ) : null}

        <View className="w-full max-w-sm mt-10">
          <PayAction
            action={action}
            username={profile.username}
            displayName={displayName}
            reserving={reserving}
            onSend={handleSend}
            onSignIn={handleSignIn}
            onOpenApp={handleOpenApp}
            onGoHome={handleGoHome}
          />

          {payError ? (
            <Text className="text-destructive text-sm text-center mt-4">{payError}</Text>
          ) : null}
        </View>
      </View>
    </SafeAreaView>
  );
}

/**
 * The one CTA the current state permits, plus the sentence that explains it.
 * Every branch that cannot send says why in the same place, so the page never
 * shows a button that dead-ends.
 */
function PayAction({
  action,
  username,
  displayName,
  reserving,
  onSend,
  onSignIn,
  onOpenApp,
  onGoHome,
}: {
  action: ReturnType<typeof decideProfilePayAction>;
  username: string;
  displayName: string;
  reserving: boolean;
  onSend: () => void;
  onSignIn: () => void;
  onOpenApp: () => void;
  onGoHome: () => void;
}) {
  switch (action.kind) {
    case "loading":
      return <ActivityIndicator />;

    case "self":
      return (
        <View className="items-center">
          <Text className="text-muted-foreground text-base text-center mb-5">
            {t("profile.self")}
          </Text>
          <ProfileQRCard username={username} />
        </View>
      );

    case "web":
      return (
        <View>
          <Text className="text-foreground text-base text-center mb-2">
            {t("profile.web.title")}
          </Text>
          <Text className="text-muted-foreground text-sm text-center mb-6 leading-5">
            {t("profile.web.description", { name: displayName })}
          </Text>
          {appScheme() ? (
            <Button
              title={t("profile.web.openApp")}
              onPress={onOpenApp}
              variant="primary"
              size="lg"
            />
          ) : null}
          <TestnetNote />
        </View>
      );

    case "signin":
      return (
        <View>
          <Text className="text-muted-foreground text-sm text-center mb-6 leading-5">
            {t("profile.signIn.description", { username })}
          </Text>
          <Button title={t("pay.signIn")} onPress={onSignIn} variant="primary" size="lg" />
          <TestnetNote />
        </View>
      );

    case "wallet-not-ready":
      return (
        <View>
          <Text className="text-muted-foreground text-sm text-center mb-6 leading-5">
            {t("profile.walletNotReady")}
          </Text>
          <Button title={t("notFound.goHome")} onPress={onGoHome} variant="primary" size="lg" />
        </View>
      );

    case "mainnet-blocked":
      return (
        <View className="bg-surface rounded-2xl p-4">
          <Text className="text-foreground text-sm text-center leading-5">
            {t("profile.mainnetBlocked", { username })}
          </Text>
        </View>
      );

    case "send":
      return (
        <View>
          <Button
            title={reserving ? t("profile.reserving") : t("profile.send", { name: displayName })}
            onPress={onSend}
            variant="primary"
            size="lg"
            loading={reserving}
            disabled={reserving}
          />
          <TestnetNote />
        </View>
      );
  }
}

/**
 * Says out loud that pay-by-@username is testnet-only. Rendered under every
 * branch that suggests a payment is possible, because the limit belongs to the
 * feature rather than to any one platform: finding F-1 (an Oxy identity key
 * rotation desyncs the shared key slot, so a payer sends to addresses the
 * recipient can neither see nor spend) blocks it from mainnet.
 */
function TestnetNote() {
  return (
    <Text className="text-muted-foreground text-xs text-center mt-4 leading-4">
      {t("profile.testnetOnly")}
    </Text>
  );
}
