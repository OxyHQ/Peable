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
import { useTheme } from "@oxy.so/bloom/theme";
import { getDatabase } from "../../wallet/wallet-store";
import {
  listBuyOrders,
  needsStatusRefresh,
  updateBuyOrderStatus,
  type BuyHistoryEntry,
} from "../../wallet/buy-history";
import { getBuyStatus } from "../../api/buy";
import type { BuyOrderStatus } from "../../api/buy";
import { formatFairAmount, t } from "../../i18n";

/** How many orders to keep on screen. Older ones stay in the database. */
const VISIBLE_ORDERS = 5;

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>["name"];

type ThemeColors = ReturnType<typeof useTheme>["colors"];

/** Icon and colour for a status, resolved straight from the theme. */
function statusStyle(
  status: BuyOrderStatus,
  colors: ThemeColors,
): { icon: IconName; color: string } {
  switch (status) {
    case "DELIVERED":
      return { icon: "check-circle", color: colors.primary };
    case "FAILED":
      return { icon: "alert-circle", color: colors.error };
    case "EXPIRED":
    case "AWAITING_PAYMENT":
      return { icon: "clock-outline", color: colors.textSecondary };
    default:
      // PAYMENT_DETECTED / SWAPPING / BURNING / DELIVERING — money is moving.
      return { icon: "progress-clock", color: colors.tint };
  }
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

    const changed = await Promise.all(
      pending.map(async (entry) => {
        try {
          const fresh = await getBuyStatus(entry.id);
          if (fresh.status === entry.status) return false;
          await updateBuyOrderStatus(db, entry.id, fresh.status, {
            deliveryTxId: fresh.fairDeliveryTxId,
            errorMessage: fresh.errorMessage,
          });
          return true;
        } catch {
          // Keep the cached row; the next visit retries.
          return false;
        }
      }),
    );
    // Only re-read when the bridge actually moved something. Otherwise every
    // focus of the Buy tab costs a second query and a full list re-render for
    // rows that are byte-identical to the ones already on screen.
    if (changed.some(Boolean)) {
      setOrders(await listBuyOrders(db, VISIBLE_ORDERS));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (orders.length === 0) return null;

  return (
    <View className="mt-8">
      <Text className="text-muted-foreground text-xs font-semibold uppercase tracking-wider mb-1">
        {t("buy.history.title")}
      </Text>

      {orders.map((order, index) => {
        const { icon, color } = statusStyle(order.status, theme.colors);
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
            <MaterialCommunityIcons name={icon} size={22} color={color} />

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
