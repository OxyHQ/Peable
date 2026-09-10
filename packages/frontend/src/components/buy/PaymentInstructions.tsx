/**
 * PaymentInstructions — payment QR, address, amount, network warning,
 * countdown, and live status for an active buy order.
 *
 * The status block reflects the BuyStatusResponse lifecycle. We avoid
 * `useEffect` for the countdown by deriving the remaining seconds from a
 * tick timestamp held in a small Zustand-free local state updated by a
 * setInterval owned by the parent screen.
 */

import { useCallback, useMemo } from "react";
import { View, Text, Pressable, ActivityIndicator } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import QRCode from "react-native-qrcode-svg";
import * as Clipboard from "expo-clipboard";
import { useTheme } from "@oxy.so/bloom/theme";
import type {
  BuyOrderStatus,
  BuyQuoteResponse,
  BuyStatusResponse,
} from "../../api/buy";
import { hapticImpact } from "../../utils/haptics";
import { t } from "../../i18n";

const QR_SIZE = 220;

/** Uppercase section label — matches the home screen's section headers. */
const SECTION_LABEL =
  "text-muted-foreground text-xs font-semibold uppercase tracking-wider";

interface PaymentInstructionsProps {
  quote: BuyQuoteResponse;
  status: BuyStatusResponse | null;
  /** Seconds remaining until the quote expires (≤ 0 ⇒ expired). */
  secondsRemaining: number;
  onCopyAddress: () => void;
  onCopyAmount: () => void;
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface StatusVisual {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
  iconColor: string;
  title: string;
  subtitle: string;
  showSpinner: boolean;
  isTerminal: boolean;
  isError: boolean;
}

function describeStatus(
  status: BuyOrderStatus | null,
  errorMessage: string | null,
  primary: string,
  warning: string,
  destructive: string,
): StatusVisual {
  switch (status) {
    case null:
    case "AWAITING_PAYMENT":
      return {
        icon: "timer-sand",
        iconColor: warning,
        title: t("buy.status.awaiting.title"),
        subtitle: t("buy.status.awaiting.subtitle"),
        showSpinner: false,
        isTerminal: false,
        isError: false,
      };
    case "PAYMENT_DETECTED":
      return {
        icon: "progress-clock",
        iconColor: primary,
        title: t("buy.status.detected.title"),
        subtitle: t("buy.status.detected.subtitle"),
        showSpinner: true,
        isTerminal: false,
        isError: false,
      };
    case "SWAPPING":
      return {
        icon: "swap-horizontal-bold",
        iconColor: primary,
        title: t("buy.status.swapping.title"),
        subtitle: t("buy.status.swapping.subtitle"),
        showSpinner: true,
        isTerminal: false,
        isError: false,
      };
    case "BURNING":
      return {
        icon: "fire",
        iconColor: primary,
        title: t("buy.status.burning.title"),
        subtitle: t("buy.status.burning.subtitle"),
        showSpinner: true,
        isTerminal: false,
        isError: false,
      };
    case "DELIVERING":
      return {
        icon: "send-circle",
        iconColor: primary,
        title: t("buy.status.delivering.title"),
        subtitle: t("buy.status.delivering.subtitle"),
        showSpinner: true,
        isTerminal: false,
        isError: false,
      };
    case "DELIVERED":
      return {
        icon: "check-circle",
        iconColor: primary,
        title: t("buy.status.delivered.title"),
        subtitle: t("buy.status.delivered.subtitle"),
        showSpinner: false,
        isTerminal: true,
        isError: false,
      };
    case "EXPIRED":
      return {
        icon: "clock-alert",
        iconColor: warning,
        title: t("buy.status.expired.title"),
        subtitle: t("buy.status.expired.subtitle"),
        showSpinner: false,
        isTerminal: true,
        isError: false,
      };
    case "FAILED":
      return {
        icon: "alert-circle",
        iconColor: destructive,
        title: t("buy.status.failed.title"),
        subtitle: errorMessage ?? t("buy.status.failed.subtitle"),
        showSpinner: false,
        isTerminal: true,
        isError: true,
      };
  }
}

export function PaymentInstructions({
  quote,
  status,
  secondsRemaining,
  onCopyAddress,
  onCopyAmount,
}: PaymentInstructionsProps) {
  const theme = useTheme();

  const visual = useMemo(
    () =>
      describeStatus(
        status?.status ?? null,
        status?.errorMessage ?? null,
        theme.colors.primary,
        theme.colors.warning ?? theme.colors.textSecondary,
        theme.colors.error ?? theme.colors.text,
      ),
    [status, theme],
  );

  const qrPayload = quote.paymentAddress ?? "";
  const showQr = qrPayload.length > 0 && !visual.isTerminal;

  const copyAddress = useCallback(async () => {
    if (!quote.paymentAddress) return;
    hapticImpact();
    await Clipboard.setStringAsync(quote.paymentAddress);
    onCopyAddress();
  }, [quote.paymentAddress, onCopyAddress]);

  const copyAmount = useCallback(async () => {
    hapticImpact();
    await Clipboard.setStringAsync(quote.paymentAmountFormatted);
    onCopyAmount();
  }, [quote.paymentAmountFormatted, onCopyAmount]);

  return (
    <View className="gap-4">
      {/* QR code — card-less: a filled surface frame, no border */}
      {showQr ? (
        <View className="items-center">
          <View className="bg-surface rounded-3xl p-5">
            <View
              className="bg-background rounded-2xl p-4 items-center justify-center"
              style={{ width: QR_SIZE + 32, height: QR_SIZE + 32 }}
            >
              <QRCode
                value={qrPayload}
                size={QR_SIZE}
                color={theme.colors.primary}
                backgroundColor="transparent"
              />
            </View>
          </View>
        </View>
      ) : null}

      {/* Address — card-less: section label above a filled surface field */}
      {quote.paymentAddress ? (
        <View>
          <Text className={SECTION_LABEL}>
            {t("buy.instructions.sendTo", {
              network: quote.paymentNetworkLabel,
              symbol: quote.paymentSymbol,
            })}
          </Text>
          <View className="bg-surface rounded-2xl px-4 py-3.5 mt-2 flex-row items-center">
            <Pressable onPress={copyAddress} className="flex-1 active:opacity-70">
              <Text
                className="text-foreground text-sm font-mono"
                selectable
                numberOfLines={2}
              >
                {quote.paymentAddress}
              </Text>
            </Pressable>
            <Pressable
              onPress={copyAddress}
              className="ml-3 w-9 h-9 rounded-full bg-primary/10 items-center justify-center active:opacity-70"
              accessibilityLabel={t("common.copy")}
            >
              <MaterialCommunityIcons
                name="content-copy"
                size={16}
                color={theme.colors.primary}
              />
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Amount — card-less: section label above a filled surface field */}
      <View>
        <Text className={SECTION_LABEL}>
          {t("buy.instructions.exactAmount")}
        </Text>
        <View className="bg-surface rounded-2xl px-4 py-3.5 mt-2 flex-row items-center">
          <Pressable onPress={copyAmount} className="flex-1 active:opacity-70">
            <Text
              className="text-foreground text-xl font-semibold"
              selectable
              numberOfLines={1}
            >
              {quote.paymentAmountFormatted} {quote.paymentSymbol}
            </Text>
          </Pressable>
          <Pressable
            onPress={copyAmount}
            className="ml-3 w-9 h-9 rounded-full bg-primary/10 items-center justify-center active:opacity-70"
            accessibilityLabel={t("common.copy")}
          >
            <MaterialCommunityIcons
              name="content-copy"
              size={16}
              color={theme.colors.primary}
            />
          </Pressable>
        </View>
      </View>

      {/* Network warning */}
      {quote.paymentAddress ? (
        <View className="flex-row items-start gap-2 px-1">
          <MaterialCommunityIcons
            name="alert-circle-outline"
            size={16}
            color={theme.colors.warning ?? theme.colors.textSecondary}
            style={{ marginTop: 2 }}
          />
          <Text className="text-xs text-muted-foreground flex-1">
            {t("buy.instructions.networkWarning", {
              network: quote.paymentNetworkLabel,
              symbol: quote.paymentSymbol,
            })}
          </Text>
        </View>
      ) : null}

      {/* Status block — card-less filled surface */}
      <View className="bg-surface rounded-2xl p-4 flex-row items-center gap-3">
        <View
          className="w-10 h-10 rounded-full items-center justify-center"
          style={{ backgroundColor: `${visual.iconColor}20` }}
        >
          {visual.showSpinner ? (
            <ActivityIndicator color={visual.iconColor} />
          ) : (
            <MaterialCommunityIcons
              name={visual.icon}
              size={22}
              color={visual.iconColor}
            />
          )}
        </View>
        <View className="flex-1">
          <Text className="text-foreground text-sm font-semibold">
            {visual.title}
          </Text>
          <Text className="text-muted-foreground text-xs mt-0.5">
            {visual.subtitle}
          </Text>
        </View>
        {!visual.isTerminal ? (
          <View className="items-end">
            <Text className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold">
              {t("buy.instructions.expiresIn")}
            </Text>
            <Text
              className="text-sm font-semibold"
              style={{
                color:
                  secondsRemaining < 60
                    ? theme.colors.warning ?? theme.colors.textSecondary
                    : theme.colors.text,
              }}
            >
              {formatCountdown(secondsRemaining)}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}
