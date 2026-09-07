/**
 * The wallet a browser CAN be: everything except spending.
 *
 * Rendered in place by `app/index.tsx` when the entry decision is `read-only`.
 * It does not navigate — its predecessor redirected to `/@you`, which put the
 * browser on a screen whose back arrow fell through to `(tabs)`, the very
 * wallet that branch exists to say is impossible here.
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
import { useQuery } from "@tanstack/react-query";
import type { SocialPayment } from "@peable.to/shared-types";
import { useWalletStore } from "../../wallet/wallet-store";
import { getMyPayments } from "../../services/gateway-client";
import { fetchBalancesSat } from "../../services/explorer-address";
import { ProfileQRCard } from "./ProfileQRCard";
import { UserAvatar } from "./UserAvatar";
import { t, formatFairAmount } from "../../i18n";

const AVATAR_SIZE = 72;

function counterpartyName(payment: SocialPayment): string {
  const { displayName, username } = payment.counterparty;
  return displayName ?? (username ? `@${username}` : t("readOnly.history.unknownParty"));
}

function PaymentRow({ payment, unspentSat }: { payment: SocialPayment; unspentSat?: bigint }) {
  const name = counterpartyName(payment);
  return (
    <View className="py-3 border-b border-border">
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

export function ReadOnlyWalletView({
  username,
  displayName,
  avatarFileId,
}: {
  username: string;
  displayName?: string;
  avatarFileId?: string;
}) {
  const network = useWalletStore((s) => s.network);

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

  return (
    <ScrollView contentContainerClassName="px-6 py-10 items-center">
      <UserAvatar
        avatarFileId={avatarFileId}
        displayName={displayName}
        username={username}
        size={AVATAR_SIZE}
      />
      <Text className="text-foreground text-2xl mt-4">{displayName ?? username}</Text>
      <Text className="text-muted-foreground text-base mb-6">@{username}</Text>

      <Text className="text-foreground text-lg text-center">{t("readOnly.title")}</Text>
      <Text className="text-muted-foreground text-sm text-center mt-2 mb-8 leading-5">
        {t("readOnly.subtitle")}
      </Text>

      <ProfileQRCard username={username} />

      <View className="w-full mt-10">
        <Text className="text-foreground text-lg mb-1">{t("readOnly.history.title")}</Text>
        <Text className="text-muted-foreground text-xs mb-3 leading-4">
          {t("readOnly.balanceNote")}
        </Text>

        {payments.isPending ? <ActivityIndicator /> : null}

        {payments.isError ? (
          <Text className="text-destructive text-sm">{t("readOnly.history.error")}</Text>
        ) : null}

        {payments.data && payments.data.payments.length === 0 ? (
          <Text className="text-muted-foreground text-sm">{t("readOnly.history.empty")}</Text>
        ) : null}

        {payments.data?.payments.map((payment) => (
          <PaymentRow
            key={payment.address}
            payment={payment}
            unspentSat={balances.data?.byAddress.get(payment.address)}
          />
        ))}
      </View>
    </ScrollView>
  );
}
