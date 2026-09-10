/**
 * ScreenHeader — common header layout with centered title and side actions.
 */

import { View, Text, Pressable } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useTheme } from "@oxy.so/bloom/theme";
import { t } from "../../i18n";

interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  leftAction?: React.ReactNode;
  rightAction?: React.ReactNode;
  /** Convenience: show a back-arrow on the left that calls this handler. */
  onBack?: () => void;
}

export function ScreenHeader({
  title,
  subtitle,
  leftAction,
  rightAction,
  onBack,
}: ScreenHeaderProps) {
  const theme = useTheme();

  const resolvedLeft =
    leftAction ??
    (onBack ? (
      <Pressable
        onPress={onBack}
        className="w-11 h-11 items-center justify-center rounded-full active:bg-surface"
        accessibilityLabel={t("common.back")}
        accessibilityRole="button"
      >
        <MaterialCommunityIcons
          name="arrow-left"
          size={24}
          color={theme.colors.text}
        />
      </Pressable>
    ) : null);

  return (
    <View className="flex-row items-center px-4 py-3">
      {/* Left action slot */}
      <View className="w-12 items-start">{resolvedLeft}</View>

      {/* Center: title + subtitle */}
      <View className="flex-1 items-center">
        <Text className="text-foreground text-lg font-semibold" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text className="text-muted-foreground text-xs mt-0.5" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      {/* Right action slot */}
      <View className="w-12 items-end">{rightAction ?? null}</View>
    </View>
  );
}
