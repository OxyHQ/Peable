/**
 * ActionButton — a rounded "pill" quick action (icon above a label) used in the
 * home actions row. Sits in a `flex-row` with `flex-1` siblings so a row of them
 * divides the width evenly. Card-less: a `surface` fill with primary-coloured,
 * left-aligned icon + label.
 */

import { Text, Pressable } from "react-native";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useTheme } from "@oxy.so/bloom/theme";

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>["name"];

interface ActionButtonProps {
  icon: IconName;
  label: string;
  onPress: () => void;
  /** Custom icon renderer; overrides `icon`. Receives the themed color + size. */
  renderIcon?: (opts: { color: string; size: number }) => React.ReactNode;
}

export function ActionButton({
  icon,
  label,
  onPress,
  renderIcon,
}: ActionButtonProps) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      className="flex-1 items-start bg-surface border border-border rounded-3xl px-3.5 py-4 active:opacity-70"
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {renderIcon ? (
        renderIcon({ color: theme.colors.primary, size: 22 })
      ) : (
        <MaterialCommunityIcons
          name={icon}
          size={22}
          color={theme.colors.primary}
        />
      )}
      <Text className="text-primary text-xs mt-1.5 font-medium">{label}</Text>
    </Pressable>
  );
}
