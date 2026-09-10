/**
 * PaymentMethodPicker — radio-style option list for the buy flow.
 *
 * Card-less rows matching the app's home/Send aesthetic: no borders, a tinted
 * `bg-primary/15` fill for the selected row and a plain `bg-surface` fill
 * otherwise. Displays the supported payment options with a "recommended" badge
 * for USDC on Base (lowest fees, instant settlement) and a "coming soon" badge
 * for unimplemented options like CARD. Tapping a disabled option is a no-op and
 * shows a subtle visual cue rather than a blocking error.
 */

import { View, Text, Pressable } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useTheme } from "@oxy.so/bloom/theme";
import type { PaymentCurrency } from "../../api/buy";
import { t } from "../../i18n";

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>["name"];

export interface PaymentMethodOption {
  currency: PaymentCurrency;
  label: string;
  description: string;
  icon: IconName;
  recommended?: boolean;
  comingSoon?: boolean;
}

interface PaymentMethodPickerProps {
  options: readonly PaymentMethodOption[];
  value: PaymentCurrency;
  onChange: (next: PaymentCurrency) => void;
}

export function PaymentMethodPicker({
  options,
  value,
  onChange,
}: PaymentMethodPickerProps) {
  const theme = useTheme();

  return (
    <View className="gap-2">
      {options.map((option) => {
        const selected = option.currency === value;
        const disabled = option.comingSoon === true;
        const handlePress = () => {
          if (!disabled) onChange(option.currency);
        };
        return (
          <Pressable
            key={option.currency}
            onPress={handlePress}
            disabled={disabled}
            className={`flex-row items-center gap-3 rounded-2xl px-4 py-3 ${
              selected ? "bg-primary/15" : "bg-surface"
            } ${disabled ? "opacity-60" : ""}`}
          >
            <View
              className={`w-10 h-10 rounded-full items-center justify-center ${
                selected ? "bg-primary/20" : "bg-background"
              }`}
            >
              <MaterialCommunityIcons
                name={option.icon}
                size={20}
                color={selected ? theme.colors.primary : theme.colors.textSecondary}
              />
            </View>
            <View className="flex-1">
              <View className="flex-row items-center gap-2 flex-wrap">
                <Text
                  className={`text-base font-semibold ${
                    selected ? "text-primary" : "text-foreground"
                  }`}
                >
                  {option.label}
                </Text>
                {option.recommended ? (
                  <View className="bg-primary/20 rounded-full px-2 py-0.5">
                    <Text className="text-primary text-[10px] font-semibold uppercase tracking-wider">
                      {t("buy.payment.recommended")}
                    </Text>
                  </View>
                ) : null}
                {option.comingSoon ? (
                  <View className="bg-warning/20 rounded-full px-2 py-0.5">
                    <Text
                      className="text-[10px] font-semibold uppercase tracking-wider"
                      style={{ color: theme.colors.textSecondary }}
                    >
                      {t("buy.payment.comingSoon")}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Text className="text-muted-foreground text-xs mt-0.5">
                {option.description}
              </Text>
            </View>
            <MaterialCommunityIcons
              name={selected ? "radiobox-marked" : "radiobox-blank"}
              size={20}
              color={selected ? theme.colors.primary : theme.colors.textSecondary}
            />
          </Pressable>
        );
      })}
    </View>
  );
}
