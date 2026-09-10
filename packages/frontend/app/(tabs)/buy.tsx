/**
 * Buy tab — entry screen for the Buy-FAIR flow.
 *
 * The user picks how much FAIR they want and how they want to pay. On
 * "Get payment instructions", the wallet:
 *
 *   1. Derives a fresh receive address on the buy-only HD chain
 *      (`m/44'/119'/0'/2/{nextBuyIndex}`) for FAIR delivery.
 *   2. Calls `requestBuyQuote` against the bridge to lock a price and
 *      allocate a per-order payment address.
 *   3. Navigates to `/buy/quote?orderId=…` which renders the QR + status.
 *
 * Watch-only wallets cannot derive addresses, so we surface a friendly
 * empty state instead of disabling the tab outright (the bottom-bar entry
 * stays consistent across wallet types).
 */

import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useTheme } from "@oxy.so/bloom/theme";
import { parseFairToUnits } from "@fairco.in/core";
import { Button, EmptyState } from "../../src/ui/components";
import { BuyAmountInput } from "../../src/components/buy/AmountInput";
import {
  PaymentMethodPicker,
  type PaymentMethodOption,
} from "../../src/components/buy/PaymentMethodPicker";
import {
  BuyApiError,
  requestBuyQuote,
  type PaymentCurrency,
} from "../../src/api/buy";
import { useWalletStore } from "../../src/wallet/wallet-store";
import { useLanguageStore } from "../../src/i18n/store";
import { FONT_PHUDU_BLACK } from "../../src/utils/fonts";
import { t } from "../../src/i18n";

const CONTENT_MAX_WIDTH = 600;

/** Uppercase section label — matches the home screen's section headers. */
const SECTION_LABEL =
  "text-muted-foreground text-xs font-semibold uppercase tracking-wider";
const PRESETS = ["10", "50", "100", "500"] as const;

/**
 * Build the payment-method list at render time so the labels reflect the
 * CURRENT language (N-8). The previous module-level constant captured
 * `t()` once at first import and never updated: changing language at
 * runtime translated the rest of the Buy screen but left the method labels
 * in whatever language was active at app launch. `_layout.tsx` remounts the
 * tree with `key={language}` on switch, which re-runs components but does
 * NOT re-execute module bodies; this hook does.
 */
function buildPaymentOptions(): readonly PaymentMethodOption[] {
  return [
    {
      currency: "USDC_BASE",
      label: t("buy.payment.usdcBase.label"),
      description: t("buy.payment.usdcBase.description"),
      icon: "currency-usd",
      recommended: true,
    },
    {
      currency: "ETH_BASE",
      label: t("buy.payment.ethBase.label"),
      description: t("buy.payment.ethBase.description"),
      icon: "ethereum",
      comingSoon: true,
    },
    {
      currency: "ETH_MAINNET",
      label: t("buy.payment.ethMainnet.label"),
      description: t("buy.payment.ethMainnet.description"),
      icon: "ethereum",
      comingSoon: true,
    },
    {
      currency: "BTC",
      label: t("buy.payment.btc.label"),
      description: t("buy.payment.btc.description"),
      icon: "bitcoin",
      comingSoon: true,
    },
    {
      currency: "CARD",
      label: t("buy.payment.card.label"),
      description: t("buy.payment.card.description"),
      icon: "credit-card-outline",
      comingSoon: true,
    },
  ];
}

function truncateMid(value: string, head: number, tail: number): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}\u2026${value.slice(-tail)}`;
}

export default function BuyScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const theme = useTheme();
  const isWatchOnly = useWalletStore((s) => s.isWatchOnly);
  const activeWalletId = useWalletStore((s) => s.activeWalletId);
  const getBuyDeliveryAddress = useWalletStore((s) => s.getBuyDeliveryAddress);

  const [amount, setAmount] = useState("");
  const [paymentCurrency, setPaymentCurrency] =
    useState<PaymentCurrency>("USDC_BASE");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-derive the payment method list whenever language changes so labels
  // and descriptions stay localised at runtime (N-8).
  const language = useLanguageStore((s) => s.language);
  // The translation function reads the store-backed locale outside React.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const paymentOptions = useMemo(() => buildPaymentOptions(), [language]);

  const amountSats = useMemo(() => parseFairToUnits(amount), [amount]);
  const canSubmit =
    amountSats !== null &&
    amountSats > 0n &&
    !submitting &&
    activeWalletId !== null;

  const handleSubmit = useCallback(async () => {
    if (!activeWalletId) {
      setError(t("buy.error.watchOnly"));
      return;
    }
    if (amountSats === null || amountSats <= 0n) return;
    setSubmitting(true);
    setError(null);
    try {
      // Deliver to a normal chain-0 receive address so the deposit is watched
      // by the Bloom filter and credited by the receive path (review finding
      // C5: the old dedicated buy chain was never watched, so bought FAIR never
      // appeared in the wallet).
      const deliveryAddress = await getBuyDeliveryAddress();
      const quote = await requestBuyQuote({
        fairAmount: amount,
        paymentCurrency,
        fairDestinationAddress: deliveryAddress,
        userIdentifier: activeWalletId,
      });
      router.push({
        pathname: "/buy/quote",
        params: { orderId: quote.id },
      });
    } catch (err: unknown) {
      if (err instanceof BuyApiError) {
        if (err.code === "below_minimum") {
          setError(t("buy.error.belowMinimum", { min: "1" }));
        } else if (err.code === "above_maximum") {
          setError(t("buy.error.aboveMaximum", { max: "1000" }));
        } else if (err.code === "card_not_configured") {
          setError(t("buy.error.cardNotConfigured"));
        } else if (err.code === "pool_quote_failed") {
          setError(t("buy.error.poolUnavailable"));
        } else {
          setError(t("buy.error.generic", { message: err.message }));
        }
      } else if (err instanceof Error) {
        setError(t("buy.error.generic", { message: err.message }));
      } else {
        setError(t("buy.error.network"));
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    activeWalletId,
    amount,
    amountSats,
    getBuyDeliveryAddress,
    paymentCurrency,
    router,
  ]);

  if (isWatchOnly) {
    return (
      <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
        <EmptyState
          icon="lock"
          title={t("buy.title")}
          subtitle={t("buy.error.watchOnly")}
        />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-40 gap-5"
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingHorizontal: 16,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View
          className="w-full self-center gap-5"
          style={{ maxWidth: CONTENT_MAX_WIDTH }}
        >
          {/* Header */}
          <View className="items-center pt-2">
            <Text
              className="text-foreground"
              style={{ fontFamily: FONT_PHUDU_BLACK, fontSize: 28 }}
            >
              {t("buy.title")}
            </Text>
            <Text className="text-muted-foreground text-sm mt-1 text-center">
              {t("buy.subtitle")}
            </Text>
          </View>

          {/* Amount — card-less hero (glyph + Phudu, like the home balance) */}
          <View className="pt-1">
            <BuyAmountInput
              value={amount}
              onValueChange={setAmount}
              presets={PRESETS}
            />
          </View>

          {/* Payment method */}
          <View className="gap-2">
            <Text className={SECTION_LABEL}>{t("buy.method.label")}</Text>
            <PaymentMethodPicker
              options={paymentOptions}
              value={paymentCurrency}
              onChange={setPaymentCurrency}
            />
          </View>

          {/* Disclosure */}
          <View className="flex-row items-start gap-2 px-1">
            <MaterialCommunityIcons
              name="information-outline"
              size={14}
              color={theme.colors.textSecondary}
              style={{ marginTop: 2 }}
            />
            <Text className="text-[11px] text-muted-foreground flex-1">
              {t("buy.disclosure")}
            </Text>
          </View>

          {/* Active-wallet badge: confirms which wallet receives FAIR. */}
          {activeWalletId ? (
            <View className="flex-row items-center gap-3 bg-surface rounded-2xl p-3.5">
              <View className="w-9 h-9 rounded-full bg-primary/10 items-center justify-center">
                <MaterialCommunityIcons
                  name="wallet"
                  size={18}
                  color={theme.colors.primary}
                />
              </View>
              <View className="flex-1">
                <Text className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
                  {t("buy.deliveryTo")}
                </Text>
                <Text
                  className="text-foreground text-sm font-semibold"
                  numberOfLines={1}
                >
                  {truncateMid(activeWalletId, 6, 6)}
                </Text>
              </View>
            </View>
          ) : null}

          {error ? (
            <View className="bg-destructive/10 rounded-2xl p-3.5">
              <Text className="text-destructive text-sm text-center">
                {error}
              </Text>
            </View>
          ) : null}
        </View>
      </ScrollView>

      {/* Fixed bottom CTA — hairline divider instead of a bordered bar */}
      <View
        className="absolute left-0 right-0 bottom-0 bg-background"
        style={{ paddingBottom: insets.bottom + 12, paddingTop: 12 }}
      >
        <View className="absolute left-0 right-0 top-0 h-px bg-border" />
        <View
          className="w-full self-center px-4"
          style={{ maxWidth: CONTENT_MAX_WIDTH }}
        >
          {submitting ? (
            <View className="items-center py-2">
              <ActivityIndicator color={theme.colors.primary} />
            </View>
          ) : (
            <Button
              title={t("buy.cta.getInstructions")}
              onPress={handleSubmit}
              variant="primary"
              size="lg"
              disabled={!canSubmit}
            />
          )}
          <Pressable accessibilityRole="none" />
        </View>
      </View>
    </View>
  );
}
