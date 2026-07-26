/**
 * ListItem — universal list row for settings, contacts, coin control, etc.
 *
 * Styled by Bloom's `Item` (leading / title / subtitle / trailing / press
 * feedback) so rows match the shared Bloom look and the active `faircoin`
 * preset. FairCoin's row conventions that Bloom's `Item` doesn't model — a
 * colored icon-circle, a rich `value` slot, an explicit chevron, and the
 * inter-row hairline — are composed on top.
 */

import { View, Text, StyleSheet } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useTheme } from "@oxyhq/bloom/theme";
import { Item } from "@oxyhq/bloom/item";

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>["name"];

interface ListItemProps {
  title: string;
  subtitle?: string;
  /**
   * Trailing value. String renders inside the standard muted Text slot;
   * a React node is rendered as-is so callers can drop in rich content
   * (e.g. <AmountText>) without needing to switch to `trailing`.
   */
  value?: string | React.ReactNode;
  icon?: IconName;
  iconColor?: string;
  iconBg?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  trailing?: React.ReactNode;
  destructive?: boolean;
  showChevron?: boolean;
  isLast?: boolean;
}

export function ListItem({
  title,
  subtitle,
  value,
  icon,
  iconColor,
  iconBg = "bg-primary/10",
  onPress,
  onLongPress,
  trailing,
  destructive = false,
  showChevron,
  isLast = false,
}: ListItemProps) {
  const theme = useTheme();
  const resolvedIconColor = iconColor ?? theme.colors.primary;
  const shouldShowChevron = showChevron ?? onPress !== undefined;

  const leading = icon ? (
    <View
      className={`w-9 h-9 rounded-full items-center justify-center ${iconBg}`}
    >
      <MaterialCommunityIcons name={icon} size={18} color={resolvedIconColor} />
    </View>
  ) : undefined;

  const hasTrailing = value != null || trailing != null || shouldShowChevron;
  const trailingContent = hasTrailing ? (
    <View className="flex-row items-center">
      {typeof value === "string" ? (
        <Text className="text-muted-foreground text-sm mr-2">{value}</Text>
      ) : value ? (
        <View className="mr-2">{value}</View>
      ) : null}
      {trailing}
      {shouldShowChevron ? (
        <MaterialCommunityIcons
          name="chevron-right"
          size={20}
          color={theme.colors.textSecondary}
        />
      ) : null}
    </View>
  ) : undefined;

  return (
    <Item
      title={title}
      subtitle={subtitle}
      leading={leading}
      trailing={trailingContent}
      onPress={onPress}
      onLongPress={onLongPress}
      destructive={destructive}
      style={
        isLast
          ? undefined
          : {
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.colors.border,
            }
      }
    />
  );
}
