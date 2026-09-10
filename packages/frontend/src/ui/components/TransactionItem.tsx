/**
 * Transaction list item — Revolut-inspired clean design.
 * Tappable to navigate to transaction details.
 */

import { useMemo } from "react";
import { View, Text, Pressable } from "react-native";
import { useRouter } from "expo-router";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useTheme } from "@oxy.so/bloom/theme";
import type { EnrichmentResult } from "@peable.to/shared-types";
import { AmountText } from "./AmountText";
import { ConfirmationRing } from "./ConfirmationRing";
import { UserAvatar } from "./UserAvatar";
import { t } from "../../i18n";

/**
 * Confirmations at which a transaction is treated as fully settled — the
 * progress ring completes and disappears. Matches the detail sheet's
 * `isConfirmed` gate.
 */
const CONFIRMED_THRESHOLD = 6;

type TransactionType = "send" | "receive" | "stake" | "masternode_reward";

interface TransactionItemProps {
  txid: string;
  type: TransactionType;
  /** Signed amount in smallest units (m⊜). The absolute value is rendered. */
  value: bigint;
  address: string;
  timestamp: number;
  confirmations: number;
  /**
   * Row tap handler. When provided (e.g. the home feed), it receives the txid
   * and the caller opens the detail bottom sheet. When omitted, the row falls
   * back to navigating to the standalone `/transaction/[txid]` route.
   */
  onPress?: (txid: string) => void;
  /**
   * Resolved counterparty identity (spec §4.8) — when present (and not
   * `kind:'unknown'`), overrides the default "Sent"/"Received" label +
   * address subtitle + leading icon with "Paid at <merchant>" / "Sent to @x"
   * / "Received from @x" + their avatar. Omit (or pass an `unknown`-kind
   * result) to keep the default rendering — the honest fallback for a pure
   * external on-chain payment (spec §4.5).
   */
  identity?: EnrichmentResult;
}

interface TypeConfig {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
  iconBg: string;
  amountColor: string;
  labelKey: string;
  prefix: string;
}

const STATIC_TYPE_CONFIG: Record<TransactionType, TypeConfig & { iconColor: string }> = {
  send: {
    icon: "arrow-up",
    iconBg: "bg-red-500/10",
    iconColor: "#f87171",
    amountColor: "text-red-400",
    labelKey: "transaction.item.sent",
    prefix: "-",
  },
  receive: {
    icon: "arrow-down",
    iconBg: "bg-primary/10",
    iconColor: "", // resolved from theme
    amountColor: "text-primary",
    labelKey: "transaction.item.received",
    prefix: "+",
  },
  stake: {
    icon: "star-outline",
    iconBg: "bg-purple-500/10",
    iconColor: "#a78bfa",
    amountColor: "text-purple-400",
    labelKey: "transaction.item.stake",
    prefix: "+",
  },
  masternode_reward: {
    icon: "server",
    iconBg: "bg-blue-500/10",
    iconColor: "#60a5fa",
    amountColor: "text-blue-400",
    labelKey: "transaction.item.masternodeReward",
    prefix: "+",
  },
};

function formatTimeAgo(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return t("transaction.item.justNow");
  if (diff < 3600) {
    return t("transaction.item.minutesAgo", { count: Math.floor(diff / 60) });
  }
  if (diff < 86400) {
    return t("transaction.item.hoursAgo", { count: Math.floor(diff / 3600) });
  }
  if (diff < 604800) {
    return t("transaction.item.daysAgo", { count: Math.floor(diff / 86400) });
  }

  const date = new Date(timestamp * 1000);
  const month = date.toLocaleString("en", { month: "short" });
  const day = date.getDate();
  return `${month} ${day}`;
}

function truncateAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

function describeIdentityLabel(type: TransactionType, identity: EnrichmentResult): string {
  if (identity.kind === "merchant") {
    return t("transaction.item.paidAt", {
      name: identity.displayName ?? t("transaction.item.merchant"),
    });
  }
  const name = identity.displayName ?? identity.username ?? "";
  return type === "send"
    ? t("transaction.item.sentToUser", { name })
    : t("transaction.item.receivedFromUser", { name });
}

export function TransactionItem({
  txid,
  type,
  value,
  address,
  timestamp,
  confirmations,
  onPress,
  identity: rawIdentity,
}: TransactionItemProps) {
  const router = useRouter();
  const theme = useTheme();
  const staticConfig = STATIC_TYPE_CONFIG[type];
  // Defensive: honor the prop's own contract (an `unknown`-kind result
  // degrades exactly like an omitted prop) even though today's one caller
  // already filters it out before passing it down.
  const identity = rawIdentity && rawIdentity.kind !== "unknown" ? rawIdentity : undefined;
  const iconColor = type === "receive" ? theme.colors.primary : staticConfig.iconColor;
  const timeAgo = useMemo(() => formatTimeAgo(timestamp), [timestamp]);
  const truncated = useMemo(() => truncateAddress(address), [address]);
  const absValue = value < 0n ? -value : value;

  // Confirmation progress (0 → CONFIRMED_THRESHOLD) drives a story-style ring
  // around the leading icon; it fills as blocks confirm and vanishes once the
  // tx is fully settled. The ring lives INSIDE the normal 44px icon footprint —
  // while confirming, the icon shrinks (w-9) to leave room for the ring so the
  // avatar never grows past a settled row's (w-11).
  const settled = confirmations >= CONFIRMED_THRESHOLD;
  const confirmProgress =
    Math.min(confirmations, CONFIRMED_THRESHOLD) / CONFIRMED_THRESHOLD;

  return (
    <Pressable
      className="flex-row items-center py-3.5 px-4 active:bg-background/50"
      onPress={() =>
        onPress ? onPress(txid) : router.push(`/transaction/${txid}`)
      }
    >
      {/* Leading icon, wrapped in a confirmation-progress ring. The ring box is
          the normal 44px icon footprint; the icon shrinks while confirming so
          the ring fits inside it and the column never grows or shifts. */}
      <View className="mr-3">
        <ConfirmationRing
          progress={confirmProgress}
          color={theme.colors.warning}
          size={44}
        >
          {identity ? (
            <UserAvatar
              avatarFileId={identity.avatarFileId}
              displayName={identity.displayName}
              username={identity.username}
              size={settled ? 44 : 36}
            />
          ) : (
            <View
              className={`${settled ? "w-11 h-11" : "w-9 h-9"} rounded-full ${staticConfig.iconBg} items-center justify-center`}
            >
              <MaterialCommunityIcons
                name={staticConfig.icon}
                size={settled ? 20 : 18}
                color={iconColor}
              />
            </View>
          )}
        </ConfirmationRing>
      </View>

      {/* Label + address */}
      <View className="flex-1 mr-3">
        <Text className="text-foreground text-sm font-medium" numberOfLines={1}>
          {identity ? describeIdentityLabel(type, identity) : t(staticConfig.labelKey)}
        </Text>
        <Text
          className="text-muted-foreground text-xs mt-0.5"
          numberOfLines={1}
        >
          {identity?.kind === "user" && identity.username ? `@${identity.username}` : truncated}
        </Text>
      </View>

      {/* Amount + time */}
      <View className="items-end">
        <AmountText
          value={absValue}
          prefix={staticConfig.prefix}
          symbol
          symbolSize={13}
          className={`text-sm font-semibold ${staticConfig.amountColor}`}
        />
        <Text className="text-muted-foreground text-xs mt-0.5">{timeAgo}</Text>
      </View>
    </Pressable>
  );
}
