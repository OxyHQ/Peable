/**
 * The wallet a browser CAN be: everything except spending.
 *
 * Rendered in place by `app/index.tsx` when the entry decision is `read-only`.
 * It does not navigate — its predecessor redirected to `/@you`, which put the
 * browser on a screen whose back arrow fell through to `(tabs)`, the very
 * wallet that branch exists to say is impossible here.
 *
 * It is laid out as the wallet HOME (`app/(tabs)/index.tsx`) — header, action
 * pills, Activity / Receive tabs — not as a profile page. An earlier version
 * led with a large avatar and the profile QR, so opening the app in a browser
 * looked like landing on someone's profile rather than on a wallet.
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

import { useState } from "react";
import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useQuery } from "@tanstack/react-query";
import { useTheme } from "@oxy.so/bloom/theme";
import { Tabs, TabsTrigger } from "@oxy.so/bloom/tabs";
import { Dialog, useDialogControl } from "@oxy.so/bloom/dialog";
import type { SocialPayment } from "@peable.to/shared-types";
import { SOCIAL_PAY_NETWORK } from "../../pay/social-network";
import { getMyPayments } from "../../services/gateway-client";
import { fetchBalancesSat } from "../../services/explorer-address";
import { SafeAreaView } from "../safe-area-view";
import { ActionButton } from "./ActionButton";
import { ArrowCircleDownIcon } from "./ArrowCircleDownIcon";
import { Badge } from "./Badge";
import { ProfileQRCard } from "./ProfileQRCard";
import { UserAvatar } from "./UserAvatar";
import { t, formatFairAmount } from "../../i18n";

const HEADER_AVATAR_SIZE = 32;

type ReadOnlyTab = "activity" | "receive";

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

export function ReadOnlyWalletView({
  username,
  displayName,
  avatarFileId,
}: {
  username: string;
  displayName?: string;
  avatarFileId?: string;
}) {
  const theme = useTheme();
  const [tab, setTab] = useState<ReadOnlyTab>("activity");
  const receiveControl = useDialogControl();

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
              avatarFileId={avatarFileId}
              displayName={displayName}
              username={username}
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
        <View className="px-4 pt-4 pb-5">
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

        {/* ---- Quick actions: only the one that needs no key ---- */}
        <View className="flex-row gap-2.5 px-4 pb-4">
          <ActionButton
            icon="arrow-down"
            label={t("wallet.receive")}
            onPress={() => receiveControl.open()}
            renderIcon={({ color, size }) => <ArrowCircleDownIcon color={color} size={size} />}
          />
        </View>

        <View className="border-b border-border px-4">
          <Tabs
            value={tab}
            onValueChange={(next) => {
              if (next === "activity" || next === "receive") setTab(next);
            }}
            variant="underline"
            style={{ borderBottomWidth: 0 }}
          >
            <TabsTrigger value="activity" label={t("wallet.activity")} />
            <TabsTrigger value="receive" label={t("wallet.receive")} />
          </Tabs>
        </View>

        {tab === "receive" ? (
          <View className="px-4 pt-8 items-center">
            <ProfileQRCard username={username} />
          </View>
        ) : (
          <View className="pt-3">
            <Text className="text-muted-foreground text-xs leading-4 px-4 mb-2">
              {t("readOnly.balanceNote")}
            </Text>

            {payments.isPending ? <ActivityIndicator className="mt-4" /> : null}

            {payments.isError ? (
              <Text className="text-destructive text-sm px-4">{t("readOnly.history.error")}</Text>
            ) : null}

            {payments.data && payments.data.payments.length === 0 ? (
              <Text className="text-muted-foreground text-sm px-4">
                {t("readOnly.history.empty")}
              </Text>
            ) : null}

            {payments.data?.payments.map((payment) => (
              <PaymentRow
                key={payment.address}
                payment={payment}
                unspentSat={balances.data?.byAddress.get(payment.address)}
              />
            ))}
          </View>
        )}
      </ScrollView>

      <Dialog control={receiveControl} placement="bottom" title={t("wallet.receive")}>
        <View className="items-center pb-6">
          <ProfileQRCard username={username} />
        </View>
      </Dialog>
    </View>
  );
}
