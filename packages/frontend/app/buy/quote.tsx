/**
 * Buy quote screen — shows the payment instructions (QR + address + amount)
 * and polls bridge status until the order reaches a terminal state.
 *
 * Polling cadence: 5s while AWAITING_PAYMENT / mid-flow, stops on
 * DELIVERED / FAILED / EXPIRED. Polling is wired through useFocusEffect so
 * it pauses when the user navigates away.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import {
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as WebBrowser from "expo-web-browser";
import { Dialog, useDialogControl } from "@oxyhq/bloom/dialog";
import { useTheme } from "@oxyhq/bloom/theme";
import { toast } from "@oxyhq/bloom/toast";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { explorerTxUrl } from "@fairco.in/core";
import {
  Button,
  EmptyState,
  ScreenHeader,
} from "../../src/ui/components";
import { SafeAreaView } from "../../src/ui/safe-area-view";
import { PaymentInstructions } from "../../src/components/buy/PaymentInstructions";
import {
  BuyApiError,
  getBuyStatus,
  type BuyOrderStatus,
  type BuyQuoteResponse,
  type BuyStatusResponse,
} from "../../src/api/buy";
import { t } from "../../src/i18n";

const CONTENT_MAX_WIDTH = 600;
const POLL_INTERVAL_MS = 5000;
const TERMINAL_STATUSES: readonly BuyOrderStatus[] = [
  "DELIVERED",
  "FAILED",
  "EXPIRED",
];

function isTerminal(status: BuyOrderStatus | null): boolean {
  return status !== null && TERMINAL_STATUSES.includes(status);
}

/**
 * The status endpoint returns enough information to reconstruct the bare
 * minimum the PaymentInstructions component needs, so we synthesise a quote
 * shape from the status payload when we don't have a separate quote in
 * memory (e.g. cold-load via shared link).
 *
 * The status endpoint doesn't surface paymentDecimals/paymentSymbol/etc., so
 * we fall back to the v1 USDC defaults — the only crypto-payment currency
 * exposed today.
 */
function quoteFromStatus(status: BuyStatusResponse): BuyQuoteResponse {
  const decimals = 6;
  const symbol = "USDC";
  // i18n-keyed labels for the synthesised quote so a cold-load via a shared
  // link still renders localised strings in the PaymentInstructions sheet
  // (N-8). The status endpoint omits these fields, so we synthesise; the
  // values are translated at the call site, not captured at module load.
  const networkLabel = t("buy.quote.networkLabel.base");
  return {
    id: status.id,
    fairAmountSats: status.fairAmountSats,
    fairDestinationAddress: status.fairDestinationAddress,
    paymentCurrency: status.paymentCurrency,
    paymentAddress: status.paymentAddress,
    paymentAmount: status.paymentAmount,
    paymentAmountFormatted: formatBigintDecimal(status.paymentAmount, decimals),
    paymentDecimals: decimals,
    paymentSymbol: symbol,
    paymentNetworkLabel: networkLabel,
    cardPaymentUrl: null,
    paymentExpiresAt: status.paymentExpiresAt,
    estimatedDeliveryTime: t("buy.quote.estimatedDelivery"),
    feeBreakdown: { uniswapBps: 0, bridgeBps: 0, slippageBufferBps: 0 },
  };
}

function formatBigintDecimal(raw: string, decimals: number): string {
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    return raw;
  }
  if (decimals <= 0) return value.toString();
  const denom = 10n ** BigInt(decimals);
  const whole = value / denom;
  const frac = value % denom;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

export default function BuyQuoteScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const theme = useTheme();
  const params = useLocalSearchParams<{ orderId?: string }>();
  const orderId = params.orderId ?? null;

  const [status, setStatus] = useState<BuyStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  const cancelControl = useDialogControl();

  const refreshStatus = useCallback(async (): Promise<BuyStatusResponse | null> => {
    if (!orderId) return null;
    try {
      const fresh = await getBuyStatus(orderId);
      setStatus(fresh);
      setError(null);
      return fresh;
    } catch (err: unknown) {
      if (err instanceof BuyApiError && err.status === 404) {
        setError(t("buy.error.generic", { message: err.message }));
      } else if (err instanceof Error) {
        setError(t("buy.error.network"));
      } else {
        setError(t("buy.error.network"));
      }
      return null;
    }
  }, [orderId]);

  // Initial load and polling lifecycle. We use focus-effect so the timer is
  // torn down when the screen unmounts or loses focus, and reattached on
  // re-focus — no leaked intervals across navigations.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      let timer: ReturnType<typeof setInterval> | null = null;

      const tick = async (): Promise<void> => {
        if (cancelled) return;
        const fresh = await refreshStatus();
        if (cancelled) return;
        setLoading(false);
        if (fresh && isTerminal(fresh.status) && timer) {
          clearInterval(timer);
          timer = null;
        }
      };

      void tick();
      timer = setInterval(() => {
        void tick();
      }, POLL_INTERVAL_MS);

      return () => {
        cancelled = true;
        if (timer) clearInterval(timer);
      };
    }, [refreshStatus]),
  );

  // Lightweight ticker for the visible countdown. 1s cadence is plenty;
  // setInterval cleanup is the canonical case for `useEffect`.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const quoteShape = useMemo<BuyQuoteResponse | null>(() => {
    if (!status) return null;
    return quoteFromStatus(status);
  }, [status]);

  const secondsRemaining = useMemo(() => {
    if (!status) return 0;
    const expiry = new Date(status.paymentExpiresAt).getTime();
    return Math.max(0, Math.floor((expiry - now) / 1000));
  }, [status, now]);

  const isFailed = status?.status === "FAILED";
  const isDelivered = status?.status === "DELIVERED";
  const explorerUrl =
    isDelivered && status?.fairDeliveryTxId
      ? explorerTxUrl(status.fairDeliveryTxId)
      : "";

  const handleViewTx = useCallback(async () => {
    if (!explorerUrl) return;
    await WebBrowser.openBrowserAsync(explorerUrl);
  }, [explorerUrl]);

  const handleCancel = useCallback(() => {
    cancelControl.open();
  }, [cancelControl]);

  const handleConfirmCancel = useCallback(() => {
    router.back();
  }, [router]);

  const handleCopiedAddress = useCallback(() => {
    toast.success(t("buy.instructions.copiedAddress"));
  }, []);

  const handleCopiedAmount = useCallback(() => {
    toast.success(t("buy.instructions.copiedAmount"));
  }, []);

  if (!orderId) {
    return (
      <SafeAreaView
        className="flex-1 bg-background"
        edges={["top", "bottom", "left", "right"]}
      >
        <ScreenHeader
          title={t("buy.title")}
          onBack={() => router.back()}
        />
        <EmptyState
          icon="alert-circle"
          title={t("notFound.title")}
          subtitle={t("notFound.description")}
        />
      </SafeAreaView>
    );
  }

  if (loading && !status) {
    return (
      <SafeAreaView
        className="flex-1 bg-background"
        edges={["top", "bottom", "left", "right"]}
      >
        <ScreenHeader title={t("buy.title")} onBack={() => router.back()} />
        <View className="flex-1 items-center justify-center px-6">
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!quoteShape || !status) {
    return (
      <SafeAreaView
        className="flex-1 bg-background"
        edges={["top", "bottom", "left", "right"]}
      >
        <ScreenHeader title={t("buy.title")} onBack={() => router.back()} />
        <EmptyState
          icon="alert-circle"
          title={t("notFound.title")}
          subtitle={error ?? t("notFound.description")}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      className="flex-1 bg-background"
      edges={["top", "left", "right"]}
    >
      <ScreenHeader
        title={t("buy.instructions.title")}
        onBack={() => router.back()}
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-6 gap-4"
        contentContainerStyle={{
          paddingTop: 4,
          paddingHorizontal: 16,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View
          className="w-full self-center gap-4"
          style={{ maxWidth: CONTENT_MAX_WIDTH }}
        >
          <PaymentInstructions
            quote={quoteShape}
            status={status}
            secondsRemaining={secondsRemaining}
            onCopyAddress={handleCopiedAddress}
            onCopyAmount={handleCopiedAmount}
          />

          {/* Card-payment shortcut: when a hosted URL is present, surface a
              button rather than relying on auto-launch (some platforms block
              the popup). Always null until business KYC. */}
          {quoteShape.cardPaymentUrl ? (
            <Button
              title={t("buy.instructions.openCardWebview")}
              onPress={() =>
                WebBrowser.openBrowserAsync(quoteShape.cardPaymentUrl ?? "")
              }
              variant="secondary"
              size="md"
            />
          ) : null}

          {error ? (
            <View className="bg-destructive/10 rounded-2xl p-3.5">
              <Text className="text-destructive text-sm text-center">
                {error}
              </Text>
            </View>
          ) : null}

          {isFailed && status.errorMessage ? (
            <View className="bg-destructive/10 rounded-2xl p-3.5">
              <Text className="text-destructive text-sm text-center">
                {status.errorMessage}
              </Text>
            </View>
          ) : null}
        </View>
      </ScrollView>

      <View
        className="border-t border-border"
        style={{ paddingBottom: Math.max(insets.bottom, 12) }}
      >
        <View
          className="w-full self-center px-4 pt-3 gap-2"
          style={{ maxWidth: CONTENT_MAX_WIDTH }}
        >
          {isDelivered ? (
            <Button
              title={t("buy.instructions.viewTx")}
              onPress={handleViewTx}
              variant="primary"
              size="lg"
              icon={
                <MaterialCommunityIcons
                  name="open-in-new"
                  size={16}
                  color={theme.colors.background}
                />
              }
              iconPosition="right"
            />
          ) : (
            <Pressable
              onPress={handleCancel}
              className="rounded-full py-3 items-center bg-surface"
              accessibilityRole="button"
            >
              <Text className="text-foreground text-sm font-semibold">
                {t("buy.instructions.cancel")}
              </Text>
            </Pressable>
          )}
        </View>
      </View>

      <Dialog
        control={cancelControl}
        placement="bottom"
        title={t("buy.instructions.cancel")}
        description={t("buy.status.expired.subtitle")}
        actions={[
          { label: t("buy.instructions.cancel"), onPress: handleConfirmCancel },
          { label: t("common.cancel"), color: "cancel" },
        ]}
      />
    </SafeAreaView>
  );
}
