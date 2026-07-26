/**
 * Recent buy orders on the Buy screen.
 *
 * Without this the flow was a dead end: the order id lived only in a navigation
 * param, so going back from the quote screen lost every trace of an order the
 * user may have already paid for. Each row is tappable and reopens that order's
 * quote screen, which is where the payment details and live progress live.
 *
 * Non-terminal orders are refreshed from the bridge on mount, so the list is
 * accurate after the app has been closed for a while rather than showing the
 * status frozen at whatever it was when the screen was last open.
 */

import { useCallback, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useTheme } from "@oxyhq/bloom/theme";
import { UNITS_PER_COIN } from "@fairco.in/core";
import { getDatabase } from "../../wallet/wallet-store";
import {
  listBuyOrders,
  needsStatusRefresh,
  updateBuyOrderStatus,
  type BuyHistoryEntry,
} from "../../wallet/buy-history";
import { getBuyStatus } from "../../api/buy";
import type { BuyOrderStatus } from "../../api/buy";
import { t } from "../../i18n";

/** How many orders to keep on screen. Older ones stay in the database. */
const VISIBLE_ORDERS = 5;

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>["name"];

interface StatusStyle {
  icon: IconName;
  /** Bloom theme colour key resolved by the caller. */
  tone: "success" | "danger" | "muted" | "progress";
}

function statusStyle(status: BuyOrderStatus): StatusStyle {
  switch (status) {
    case "DELIVERED":
      return { icon: "check-circle", tone: "success" };
    case "FAILED":
      return { icon: "alert-circle", tone: "danger" };
    case "EXPIRED":
      return { icon: "clock-alert-outline", tone: "muted" };
    case "AWAITING_PAYMENT":
      return { icon: "clock-outline", tone: "muted" };
    default:
      // PAYMENT_DETECTED / SWAPPING / BURNING / DELIVERING — money is moving.
      return { icon: "progress-clock", tone: "progress" };
  }
}

function formatFairAmount(sats: bigint): string {
  const whole = Number(sats) / Number(UNITS_PER_COIN);
  return whole.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

export function BuyHistoryList() {
  const router = useRouter();
  const theme = useTheme();
  const [orders, setOrders] = useState<BuyHistoryEntry[]>([]);

  const load = useCallback(async () => {
    const db = getDatabase();
    if (!db) return;

    const stored = await listBuyOrders(db, VISIBLE_ORDERS);
    setOrders(stored);

    // Re-ask the bridge about anything still in flight. Best-effort: offline or
    // a bridge outage just leaves the cached status on screen.
    const pending = stored.filter(needsStatusRefresh);
    if (pending.length === 0) return;

    await Promise.all(
      pending.map(async (entry) => {
        try {
          const fresh = await getBuyStatus(entry.id);
          if (fresh.status === entry.status) return;
          await updateBuyOrderStatus(db, entry.id, fresh.status, {
            deliveryTxId: fresh.fairDeliveryTxId,
            errorMessage: fresh.errorMessage,
          });
        } catch {
          // Keep the cached row; the next visit retries.
        }
      }),
    );
    setOrders(await listBuyOrders(db, VISIBLE_ORDERS));
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (orders.length === 0) return null;

  const toneColor = (tone: StatusStyle["tone"]): string => {
    if (tone === "success") return theme.colors.primary;
    if (tone === "danger") return theme.colors.error;
    if (tone === "progress") return theme.colors.tint;
    return theme.colors.textSecondary;
  };

  return (
    <View className="mt-8">
      <Text className="text-muted-foreground text-xs font-semibold uppercase tracking-wider mb-1">
        {t("buy.history.title")}
      </Text>

      {orders.map((order, index) => {
        const style = statusStyle(order.status);
        const color = toneColor(style.tone);
        return (
          <Pressable
            key={order.id}
            onPress={() =>
              router.push({
                pathname: "/buy/quote",
                params: { orderId: order.id },
              })
            }
            accessibilityRole="button"
            accessibilityLabel={t("buy.history.openOrder", {
              amount: formatFairAmount(order.fairAmountSats),
            })}
            className={`flex-row items-center py-3.5 active:opacity-70 ${
              index === orders.length - 1 ? "" : "border-b border-border"
            }`}
          >
            <MaterialCommunityIcons name={style.icon} size={22} color={color} />

            <View className="flex-1 ml-3">
              <Text className="text-foreground text-[15px] font-medium">
                {t("buy.history.amount", {
                  amount: formatFairAmount(order.fairAmountSats),
                })}
              </Text>
              <Text className="text-muted-foreground text-[13px] mt-0.5">
                {order.paymentAmountFormatted} {order.paymentSymbol}
              </Text>
            </View>

            <Text className="text-[13px] font-medium" style={{ color }}>
              {t(`buy.status.${order.status}`)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
