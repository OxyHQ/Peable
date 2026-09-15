/**
 * The wallet a browser CAN be: everything except spending.
 *
 * Rendered by the `(tabs)` home and receive screens when the host's capability
 * is `read-only` (`src/wallet/capability.ts`) — inside the shell, so the
 * navigation rail and Settings are there like on any other host. Two earlier
 * homes for it both lost that: a redirect to `/@you`, whose back arrow fell
 * into a `(tabs)` that bounced it, and a render in place on `app/index.tsx`,
 * outside the shell.
 *
 * Laid out as the wallet HOME (`app/(tabs)/index.tsx`): header, then activity.
 * The receive code is the rail's Receive tab (`ReadOnlyReceiveView`). Not as a profile page — leading with a big avatar and
 * the QR made opening the app in a browser look like landing on a profile.
 *
 * WHAT IT CAN SHOW, AND WHY NONE OF IT NEEDS A KEY. The receive code derives
 * from a public handle; the payment history is the caller's own rows in the
 * gateway, answered by identity rather than by derived addresses; the amounts
 * are public chain data read from the Explorer. Only signing needs the seed,
 * and the seed derives from a keystore a browser does not have.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW: a headline wallet balance. Without the
 * account xpub this surface knows only the single-use addresses Peable minted
 * for it, so summing them would produce a confident number that is NOT the
 * user's balance — the worst of the three options. It reports per-address
 * amounts still sitting unswept, and says whose number it is.
 */

import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@oxy.so/services";
import { useTheme } from "@oxy.so/bloom/theme";
import type { SocialPayment } from "@peable.to/shared-types";
import { SOCIAL_PAY_NETWORK } from "../../pay/social-network";
import { getMyPayments } from "../../services/gateway-client";
import { fetchBalancesSat } from "../../services/explorer-address";
import { SafeAreaView } from "../safe-area-view";
import { Badge } from "./Badge";
import { ProfileQRCard } from "./ProfileQRCard";
import { UserAvatar } from "./UserAvatar";
import { t, formatFairAmount } from "../../i18n";

const HEADER_AVATAR_SIZE = 32;

function counterpartyName(payment: SocialPayment): string {
  const { displayName, username } = payment.counterparty;
  return displayName ?? (username ? `@${username}` : t("readOnly.history.unknownParty"));
}

function PaymentRow({ payment, unspentSat }: { payment: SocialPayment; unspentSat?: bigint }) {
  const name = counterpartyName(payment);
  return (
    <View className="px-4 py-3 border-b border-border">
      <Text className="text-foreground text-base">
        {payment.direction === "sent"
          ? t("readOnly.history.sent", { name })
          : t("readOnly.history.received", { name })}
      </Text>
      <Text className="text-muted-foreground text-xs mt-1">
        {new Date(payment.createdAt).toLocaleDateString()}
      </Text>
      {/* Shown only when the address still holds something. A swept address
          reads 0, and printing "0 FAIR" against a real past payment would say
          the payment never happened. */}
      {unspentSat !== undefined && unspentSat > 0n ? (
        <Text className="text-muted-foreground text-xs mt-1">
          {t("readOnly.history.unclaimed", { amount: formatFairAmount(unspentSat) })}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The read-only capability is only reachable signed in, so `username` is
 * always present in practice. This exists so a malformed session renders a
 * sentence instead of a blank screen.
 */
function MissingHandle() {
  return (
    <View className="flex-1 bg-background items-center justify-center px-8">
      <Text className="text-foreground text-2xl text-center mb-3">{t("onboarding.webFallbackTitle")}</Text>
      <Text className="text-muted-foreground text-base text-center">{t("onboarding.webFallbackSubtitle")}</Text>
    </View>
  );
}

/** The receive code a keyless host can offer: the profile link, as a QR. */
export function ReadOnlyReceiveView() {
  const { user } = useAuth();
  if (!user?.username) return <MissingHandle />;
  return (
    <View className="items-center py-4">
      <Text className="text-foreground text-2xl font-semibold text-center">{t("receive.title")}</Text>
      <Text className="text-muted-foreground text-sm text-center mt-2 mb-8 leading-5 max-w-sm">
        {t("profile.self")}
      </Text>
      <ProfileQRCard username={user.username} />
    </View>
  );
}

export function ReadOnlyWalletView() {
  const { user } = useAuth();
  const theme = useTheme();

  // NOT `useWalletStore((s) => s.network)`. No wallet initializes on this
  // surface — that is what makes it read-only — so the store never leaves its
  // default of `mainnet`, while the app can only create social payments on
  // `SOCIAL_PAY_NETWORK`. Reading the store here asked about the one network
  // that structurally has nothing to show, and every web visitor saw an empty
  // history that looked exactly like never having been paid.
  const network = SOCIAL_PAY_NETWORK;

  const payments = useQuery({
    queryKey: ["read-only-payments", network],
    queryFn: () => getMyPayments(network),
  });

  const addresses = payments.data?.payments.map((payment) => payment.address) ?? [];

  // Chain amounts are a SEPARATE query on purpose: the Explorer is a third
  // party, and a history that already loaded must not disappear because the
  // chain read failed. This one is allowed to be absent.
  const balances = useQuery({
    queryKey: ["read-only-balances", network, addresses],
    queryFn: () => fetchBalancesSat(addresses, network),
    enabled: addresses.length > 0,
  });

  if (!user?.username) return <MissingHandle />;

  return (
    <View className="flex-1 bg-background">
      {/* ---- Header: same shape as the wallet home, with the capability named ---- */}
      <SafeAreaView edges={["top"]}>
        <View className="px-4 pt-3 pb-2 flex-row items-center justify-between">
          <View className="flex-row items-center">
            <View className="w-9 h-9 rounded-xl bg-primary items-center justify-center mr-2.5">
              <MaterialCommunityIcons name="wallet" size={18} color={theme.colors.background} />
            </View>
            <Text className="text-foreground text-xl font-semibold">{t("wallet.defaultName")}</Text>
          </View>
          <View className="flex-row items-center gap-3">
            <Badge text={t("readOnly.badge")} variant="neutral" size="sm" />
            <UserAvatar
              avatarFileId={user.avatar ?? undefined}
              displayName={user.name?.displayName ?? undefined}
              username={user.username}
              size={HEADER_AVATAR_SIZE}
            />
          </View>
        </View>
      </SafeAreaView>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      >
        {/* ---- Where the balance sits on the home: what this surface can't do ---- */}
        <View className="px-4 pt-4 pb-6">
          <View className="bg-surface rounded-2xl p-4 flex-row items-center">
            <MaterialCommunityIcons
              name="cellphone-key"
              size={22}
              color={theme.colors.textSecondary}
            />
            <Text className="text-muted-foreground text-sm leading-5 ml-3 flex-1">
              {t("readOnly.notice")}
            </Text>
          </View>
        </View>

        {/* ---- Activity ---- */}
        <Text className="text-muted-foreground text-xs font-semibold uppercase px-4 mb-1">
          {t("wallet.activity")}
        </Text>
        <Text className="text-muted-foreground text-xs leading-4 px-4 mb-2">
          {t("readOnly.balanceNote")}
        </Text>

        {payments.isPending ? <ActivityIndicator className="mt-4" /> : null}

        {payments.isError ? (
          <Text className="text-destructive text-sm px-4">{t("readOnly.history.error")}</Text>
        ) : null}

        {payments.data && payments.data.payments.length === 0 ? (
          <Text className="text-muted-foreground text-sm px-4">{t("readOnly.history.empty")}</Text>
        ) : null}

        {payments.data?.payments.map((payment) => (
          <PaymentRow
            key={payment.address}
            payment={payment}
            unspentSat={balances.data?.byAddress.get(payment.address)}
          />
        ))}
      </ScrollView>
    </View>
  );
}
