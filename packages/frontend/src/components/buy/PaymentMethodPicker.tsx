/**
 * PaymentMethodPicker — radio option list for the buy flow, styled as a single
 * Bloom-style grouped section: one rounded `bg-surface` container with the
 * options as rows separated by inset hairline dividers (matching the Settings
 * grouped sections and the rest of the app), a green icon-circle per row, a
 * trailing radio for the selection, and "recommended" / "coming soon" badges.
 * Tapping a disabled (coming-soon) option is a no-op.
 */

import { View, Text, Pressable } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useTheme } from "@oxyhq/bloom/theme";
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
    <View className="rounded-2xl bg-surface overflow-hidden">
      {options.map((option, index) => {
        const selected = option.currency === value;
        const disabled = option.comingSoon === true;
        const handlePress = () => {
          if (!disabled) onChange(option.currency);
        };
        return (
          <View key={option.currency}>
            {/* Inset hairline divider between rows — aligned past the icon,
                exactly like Bloom's grouped-section rows. */}
            {index > 0 ? <View className="h-px bg-border ml-16" /> : null}
            <Pressable
              onPress={handlePress}
              disabled={disabled}
              accessibilityRole="radio"
              accessibilityState={{ selected, disabled }}
              className={`flex-row items-center gap-3 px-4 py-3.5 ${
                disabled ? "opacity-50" : "active:opacity-70"
              }`}
            >
              <View className="w-9 h-9 rounded-full bg-primary/10 items-center justify-center">
                <MaterialCommunityIcons
                  name={option.icon}
                  size={18}
                  color={theme.colors.primary}
                />
              </View>
              <View className="flex-1">
                <View className="flex-row items-center gap-2 flex-wrap">
                  <Text className="text-foreground text-[15px] font-semibold">
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
              {!disabled ? (
                <MaterialCommunityIcons
                  name={selected ? "radiobox-marked" : "radiobox-blank"}
                  size={20}
                  color={
                    selected ? theme.colors.primary : theme.colors.textSecondary
                  }
                />
              ) : null}
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}
